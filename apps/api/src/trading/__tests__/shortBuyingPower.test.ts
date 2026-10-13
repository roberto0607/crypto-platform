/**
 * shortBuyingPower.test.ts: short-sale proceeds are not spendable (QA F5).
 *
 * The order checks used USD balance − reserved, so a short's proceeds counted
 * as cash: short, then spend the proceeds on more exposure (hidden leverage).
 * Now anything that opens risk must leave buying power (the 2× rule,
 * trading/buyingPower.ts) >= 0; reduce-only orders always pass.
 *
 * Real Postgres and the real order pipeline. Pair fixture: BTC/USD, taker 5 bps.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { allowSymbolForTest } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../phase6OrderService";

let pairId: string;
let ethPairId: string;
let btcAssetId: string;
let usdAssetId: string;
let ethAssetId: string;
let userId: string;

const order = (side: "BUY" | "SELL", qty: string, pair = pairId) =>
    placeOrderWithSnapshot(userId, { pairId: pair, side, type: "MARKET", qty });
const limit = (side: "BUY" | "SELL", qty: string, limitPrice: string) =>
    placeOrderWithSnapshot(userId, { pairId, side, type: "LIMIT", qty, limitPrice });

async function balanceOf(assetId: string) {
    const { rows } = await pool.query<{ balance: string }>(
        `SELECT balance::text FROM wallets WHERE user_id = $1 AND asset_id = $2`, [userId, assetId]);
    return Number(rows[0].balance);
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;

    const { rows: [eth] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ('ETH', 'Ether', 8) RETURNING id`);
    ethAssetId = eth.id;
    const { rows: [ethPair] } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, maker_fee_bps, taker_fee_bps)
         VALUES ($1, $2, $3, true, '2500.00000000', 2, 5) RETURNING id`,
        [ethAssetId, usdAssetId, allowSymbolForTest("ETH/USD")],
    );
    ethPairId = ethPair.id;

    userId = (await createTestUser(pool)).id;
    await createTestWallets(pool, userId, btcAssetId, usdAssetId, "0.00000000", "100000.00000000");
    await pool.query(`INSERT INTO wallets (user_id, asset_id, balance, reserved) VALUES ($1, $2, 0, 0)`, [userId, ethAssetId]);

    seedReferenceBook(pairId, "50000", "50000");
    seedReferenceBook(ethPairId, "2500", "2500");
});

describe("short proceeds are not buying power", () => {
    it("short, then spend the proceeds on a long elsewhere: rejected (the QA repro)", async () => {
        await order("SELL", "1.50000000"); // $75k short → USD ≈ 175k, buying power ≈ 25k
        expect(await balanceOf(usdAssetId)).toBeGreaterThan(174900);

        // $50k of ETH: the old check saw 175k of cash and filled it.
        await expect(order("BUY", "20.00000000", ethPairId)).rejects.toThrow(/insufficient_balance/);
        expect(await balanceOf(ethAssetId)).toBe(0);

        // Within buying power still works.
        await order("BUY", "8.00000000", ethPairId); // $20k
        expect(await balanceOf(ethAssetId)).toBe(8);
    });

    it("stacking shorts past 1x is rejected", async () => {
        await order("SELL", "1.50000000"); // buying power ≈ 25k
        await expect(order("SELL", "1.00000000")).rejects.toThrow(/insufficient_balance/);
        expect(await balanceOf(btcAssetId)).toBe(-1.5);
    });

    it("a resting short limit counts against buying power", async () => {
        await limit("SELL", "1.50000000", "60000"); // rests: 1x of 75k held → 25k left
        await expect(limit("SELL", "1.00000000", "60000")).rejects.toThrow(/insufficient_balance/);
    });

    it("a short that went against you: negative buying power, can still cover, can't add", async () => {
        await order("SELL", "1.50000000"); // at 50k
        seedReferenceBook(pairId, "70000", "70000"); // buying power ≈ 175k − 2×1.5×70k < 0

        await expect(order("SELL", "0.10000000")).rejects.toThrow(/insufficient_balance/);
        await order("BUY", "0.50000000"); // partial cover: reduce-only, allowed
        expect(await balanceOf(btcAssetId)).toBe(-1);
        await order("BUY", "1.00000000"); // full cover
        expect(await balanceOf(btcAssetId)).toBe(0);
    });
});

describe("closing never needs spare cash", () => {
    it("a long that used almost all the cash can be closed", async () => {
        await order("BUY", "1.99000000"); // $99.5k + fee → ≈ $450 cash left
        expect(await balanceOf(usdAssetId)).toBeLessThan(1000);

        // The old SELL check wanted USD available >= the sale's notional.
        await order("SELL", "1.99000000");
        expect(await balanceOf(btcAssetId)).toBe(0);
        expect(await balanceOf(usdAssetId)).toBeGreaterThan(99800);
    });

    it("a short can be flipped to a long only within buying power", async () => {
        await order("SELL", "1.00000000"); // buying power ≈ 50k
        await order("BUY", "1.50000000"); // cover 1, open a $25k long
        expect(await balanceOf(btcAssetId)).toBe(0.5);
    });
});
