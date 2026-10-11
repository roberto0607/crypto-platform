/**
 * fees.test.ts — fills charge exactly the fee the UI shows, and the journal
 * agrees with the wallet.
 *
 * Regression for the 2026-10-11 QA finding: the matching engine charged the
 * deprecated trading_pairs.fee_bps (30) on every taker fill and nothing on
 * maker fills, while the order form, positions and journal used
 * taker_fee_bps (5) / maker_fee_bps (2). feeCalc.ts is now the only fee source.
 *
 * Real Postgres, real placeOrderWithSnapshot → matching engine → positions →
 * journal. The fixture pair is maker 2 / taker 5; fee_bps is set to a bogus
 * 999 so any code path that still reads it fails loudly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { config } from "../../config";
import { D } from "../../utils/decimal";

const PRICE = "50000";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

async function newTrader(btc = "0.00000000", usd = "100000.00000000") {
    const user = await createTestUser(pool);
    const w = await createTestWallets(pool, user.id, btcAssetId, usdAssetId, btc, usd);
    return { id: user.id, btcWallet: w.btcWallet.id, usdWallet: w.usdWallet.id };
}

async function usdBalance(walletId: string) {
    const { rows } = await pool.query<{ balance: string; reserved: string }>(
        `SELECT balance::text, reserved::text FROM wallets WHERE id = $1`, [walletId],
    );
    return rows[0];
}

/** Ledger entries a trade wrote to one wallet: { amount, fee, feeRole }. */
async function ledgerFor(walletId: string, tradeId: string) {
    const { rows } = await pool.query<{ amount: string; metadata: { fee?: string; feeRole?: string } }>(
        `SELECT amount::text, metadata FROM ledger_entries WHERE wallet_id = $1 AND reference_id = $2`,
        [walletId, tradeId],
    );
    expect(rows).toHaveLength(1);
    return { amount: rows[0].amount, fee: rows[0].metadata.fee, feeRole: rows[0].metadata.feeRole };
}

async function journalNet(userId: string) {
    const { rows } = await pool.query<{ net: string | null; n: string }>(
        `SELECT sum(net_pnl)::text AS net, count(*)::text AS n FROM closed_trades WHERE user_id = $1`, [userId],
    );
    return { net: D(rows[0].net ?? "0"), count: Number(rows[0].n) };
}

const bps = (notional: string, rate: number) => D(notional).mul(rate).div(10_000).toFixed(8);

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
    await pool.query(`UPDATE trading_pairs SET fee_bps = 999 WHERE id = $1`, [pairId]);
    seedReferenceBook(pairId, PRICE, PRICE);
});

describe("taker fee", () => {
    it("a market buy (system fill) is charged exactly taker_fee_bps", async () => {
        const t = await newTrader();
        const before = D((await usdBalance(t.usdWallet)).balance);

        const { fills } = await placeOrderWithSnapshot(t.id, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });
        expect(fills).toHaveLength(1);
        const notional = fills[0].quote_amount;        // 500.00000000
        const fee = bps(notional, 5);                  // 0.25000000

        expect(fills[0].fee_amount).toBe(fee);
        const entry = await ledgerFor(t.usdWallet, fills[0].id);
        expect(entry).toMatchObject({ fee, feeRole: "TAKER" });

        const after = D((await usdBalance(t.usdWallet)).balance);
        expect(before.minus(after).toFixed(8)).toBe(D(notional).plus(fee).toFixed(8));
    });

    it("a market sell (short) is credited notional minus exactly taker_fee_bps", async () => {
        const t = await newTrader();
        const before = D((await usdBalance(t.usdWallet)).balance);

        const { fills } = await placeOrderWithSnapshot(t.id, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000" });
        const fee = bps(fills[0].quote_amount, 5);

        const after = D((await usdBalance(t.usdWallet)).balance);
        expect(after.minus(before).toFixed(8)).toBe(D(fills[0].quote_amount).minus(fee).toFixed(8));
        expect((await ledgerFor(t.usdWallet, fills[0].id)).fee).toBe(fee);
    });
});

describe("maker fee", () => {
    it("a resting SELL that gets hit pays maker_fee_bps; the taker pays taker_fee_bps", async () => {
        const maker = await newTrader("1.00000000");
        const taker = await newTrader();
        await placeOrderWithSnapshot(maker.id, { pairId, side: "SELL", type: "LIMIT", qty: "0.01000000", limitPrice: PRICE });
        const makerBefore = D((await usdBalance(maker.usdWallet)).balance);

        const { fills } = await placeOrderWithSnapshot(taker.id, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });
        expect(fills).toHaveLength(1);
        expect(fills[0].is_system_fill).toBe(false);
        const notional = fills[0].quote_amount;

        expect((await ledgerFor(taker.usdWallet, fills[0].id)).fee).toBe(bps(notional, 5));
        const makerEntry = await ledgerFor(maker.usdWallet, fills[0].id);
        expect(makerEntry).toMatchObject({ fee: bps(notional, 2), feeRole: "MAKER" });

        const makerAfter = D((await usdBalance(maker.usdWallet)).balance);
        expect(makerAfter.minus(makerBefore).toFixed(8)).toBe(D(notional).minus(bps(notional, 2)).toFixed(8));
    });

    it("a resting BUY that gets hit pays maker_fee_bps and its whole reserve is settled", async () => {
        const maker = await newTrader();
        const taker = await newTrader("1.00000000");
        const makerStart = D((await usdBalance(maker.usdWallet)).balance);

        await placeOrderWithSnapshot(maker.id, { pairId, side: "BUY", type: "LIMIT", qty: "0.01000000", limitPrice: PRICE });
        // Reserved at the higher of maker/taker (5 bps): 500 + 0.25
        expect((await usdBalance(maker.usdWallet)).reserved).toBe("500.25000000");

        const { fills } = await placeOrderWithSnapshot(taker.id, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000" });
        const notional = fills[0].quote_amount;

        const makerWallet = await usdBalance(maker.usdWallet);
        expect(makerWallet.reserved).toBe("0.00000000");
        expect(makerStart.minus(D(makerWallet.balance)).toFixed(8)).toBe(D(notional).plus(bps(notional, 2)).toFixed(8));
        expect(await ledgerFor(maker.usdWallet, fills[0].id)).toMatchObject({ fee: bps(notional, 2), feeRole: "MAKER" });
        expect((await ledgerFor(taker.usdWallet, fills[0].id)).fee).toBe(bps(notional, 5));
    });

    describe("market-maker bot", () => {
        const savedBot = config.botUserId;
        afterEach(() => { config.botUserId = savedBot; });

        it("pays no maker fee when its resting order is hit", async () => {
            const bot = await newTrader("1.00000000");
            config.botUserId = bot.id;
            const taker = await newTrader();
            await placeOrderWithSnapshot(bot.id, { pairId, side: "SELL", type: "LIMIT", qty: "0.01000000", limitPrice: PRICE });
            const botBefore = D((await usdBalance(bot.usdWallet)).balance);

            const { fills } = await placeOrderWithSnapshot(taker.id, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });

            const botAfter = D((await usdBalance(bot.usdWallet)).balance);
            expect(botAfter.minus(botBefore).toFixed(8)).toBe(fills[0].quote_amount);
            expect((await ledgerFor(bot.usdWallet, fills[0].id)).fee).toBe("0.00000000");
            // The taker still pays the normal taker fee.
            expect((await ledgerFor(taker.usdWallet, fills[0].id)).fee).toBe(bps(fills[0].quote_amount, 5));
        });
    });
});

describe("journal agrees with the wallet", () => {
    it("long round trip: journal net P&L equals the USD wallet change", async () => {
        const t = await newTrader();
        const start = D((await usdBalance(t.usdWallet)).balance);

        await placeOrderWithSnapshot(t.id, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });
        seedReferenceBook(pairId, "50500", "50500");
        await placeOrderWithSnapshot(t.id, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000" });

        const walletChange = D((await usdBalance(t.usdWallet)).balance).minus(start);
        const journal = await journalNet(t.id);
        expect(journal.count).toBe(1);
        // gross +5.00, fees 0.25 + 0.2525 → net +4.4975
        expect(walletChange.toFixed(8)).toBe("4.49750000");
        expect(journal.net.minus(walletChange).abs().lte("0.00000001")).toBe(true);
    });

    it("short round trip: journal net P&L equals the USD wallet change", async () => {
        const t = await newTrader();
        const start = D((await usdBalance(t.usdWallet)).balance);

        await placeOrderWithSnapshot(t.id, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000" });
        seedReferenceBook(pairId, "49000", "49000");
        await placeOrderWithSnapshot(t.id, { pairId, side: "BUY", type: "MARKET", qty: "0.01000000" });

        const walletChange = D((await usdBalance(t.usdWallet)).balance).minus(start);
        const journal = await journalNet(t.id);
        expect(journal.count).toBe(1);
        // gross +10.00, fees 0.25 + 0.245 → net +9.505
        expect(walletChange.toFixed(8)).toBe("9.50500000");
        expect(journal.net.minus(walletChange).abs().lte("0.00000001")).toBe(true);
    });

    it("maker round trip (limit entry rests, market exit): journal equals wallet", async () => {
        const t = await newTrader();
        const counter = await newTrader("1.00000000");
        const start = D((await usdBalance(t.usdWallet)).balance);

        await placeOrderWithSnapshot(t.id, { pairId, side: "BUY", type: "LIMIT", qty: "0.01000000", limitPrice: PRICE });
        await placeOrderWithSnapshot(counter.id, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000" });
        seedReferenceBook(pairId, "50500", "50500");
        await placeOrderWithSnapshot(t.id, { pairId, side: "SELL", type: "MARKET", qty: "0.01000000" });

        const wallet = await usdBalance(t.usdWallet);
        expect(wallet.reserved).toBe("0.00000000");
        const walletChange = D(wallet.balance).minus(start);
        // gross +5.00, maker 0.10 + taker 0.2525 → net +4.6475
        expect(walletChange.toFixed(8)).toBe("4.64750000");
        const journal = await journalNet(t.id);
        expect(journal.net.minus(walletChange).abs().lte("0.00000001")).toBe(true);
    });
});
