/**
 * largeMatchClose.test.ts: match end prices a large close like any other
 * (touch band + book walk + impact past the book), so holding a position to
 * match end can't dodge exit slippage. The loss cap still holds.
 *
 * Real Postgres; real accept / order pipeline / completeMatch. BTC/USD taker
 * 5 bps. Bids: 2 @ 99,990, 3 @ 99,980, 5 @ 99,970, 90 @ 99,890.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
}));

import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedDepthBook, clearReferenceBooks, seedTicker } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createMatch, acceptMatch, completeMatch } from "../matchService";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let alice: string;
let bob: string;

const savedLeverage = { ...config.leverage };
const ASKS: [number, number][] = [[100_000, 2], [100_010, 3], [100_020, 5], [100_100, 90]];
const BIDS: [number, number][] = [[99_990, 2], [99_980, 3], [99_970, 5], [99_890, 90]];

function enableLeverage() {
    Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [] });
}

async function trader() {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "100000.00000000");
    return u.id;
}

/** An accepted match with `usd` in alice's match USD wallet. */
async function matchWith(usd: string): Promise<string> {
    const m = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(m.id, bob);
    await pool.query(
        `UPDATE wallets SET balance = $1 WHERE match_id = $2 AND user_id = $3 AND asset_id = $4`,
        [usd, m.id, alice, usdAssetId],
    );
    return m.id;
}

const inMatch = (id: string, side: "BUY" | "SELL", qty: string, leverage?: number) =>
    placeOrderWithSnapshot(alice, { pairId, side, type: "MARKET", qty, leverage }, undefined, undefined, null, id);

async function usdBalance(id: string): Promise<number> {
    const { rows } = await pool.query<{ balance: string }>(
        `SELECT balance::text FROM wallets WHERE user_id = $1 AND asset_id = $2 AND match_id = $3`,
        [alice, usdAssetId, id],
    );
    return Number(rows[0].balance);
}

async function closingPrice(id: string): Promise<number> {
    const { rows } = await pool.query<{ price: string }>(
        `SELECT t.price::text FROM trades t JOIN orders o ON o.id = t.sell_order_id OR o.id = t.buy_order_id
         WHERE o.match_id = $1 AND o.user_id = $2 ORDER BY t.executed_at DESC, t.id LIMIT 1`,
        [id, alice],
    );
    return Number(rows[0].price);
}

async function realized(id: string): Promise<number> {
    const { rows } = await pool.query<{ realized_pnl_quote: string }>(
        `SELECT realized_pnl_quote::text FROM positions WHERE match_id = $1 AND user_id = $2`, [id, alice]);
    return Number(rows[0].realized_pnl_quote);
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
    await pool.query(`UPDATE trading_pairs SET last_price = '100000' WHERE id = $1`, [pairId]);
    seedDepthBook(pairId, BIDS, ASKS);
    alice = await trader();
    bob = await trader();
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage);
});

// 10 BTC bought at 100,013. The close sells 10 from 99,990: the $50k band at
// the touch, then the rest of the bid from where it ends. The band fits in the
// first level, so the average is the plain walk: 2 + 3 + 5 → 99,977.
const WALKED_SELL = 99_977;

describe("match end, a $1M position", () => {
    it("ISOLATED: closes at the walked price, not the touch; margin + P&L come back", async () => {
        enableLeverage();
        const id = await matchWith("300000.00000000");
        await inMatch(id, "BUY", "10.00000000", 5);
        const afterOpen = await usdBalance(id);

        await completeMatch(id);

        const exit = await closingPrice(id);
        expect(exit).toBeCloseTo(WALKED_SELL, 4);
        expect(exit).toBeLessThan(99_990);
        const pnl = 10 * (exit - 100_013);
        expect(await realized(id)).toBeCloseTo(pnl, 4);
        // Margin 200,026 back, plus the (negative) P&L, less the 5 bps close fee.
        expect(await usdBalance(id)).toBeCloseTo(afterOpen + 200_026 + pnl - 10 * exit * 0.0005, 4);
    });

    it("ISOLATED: a thin book past bankruptcy loses the margin and no more, the shortfall is booked", async () => {
        enableLeverage();
        const id = await matchWith("200600.00000000");
        await inMatch(id, "BUY", "10.00000000", 5);
        const afterOpen = await usdBalance(id);

        // Bankruptcy 100,013 × 0.8 = 80,010.4. Nothing near it on the bid.
        seedDepthBook(pairId, [[85_000, 0.6], [70_000, 100]], ASKS);
        await completeMatch(id);

        const exit = await closingPrice(id);
        expect(exit).toBeLessThan(80_010.4);
        expect(await usdBalance(id)).toBeCloseTo(afterOpen, 6); // the margin is gone, nothing else
        expect(await usdBalance(id)).toBeGreaterThanOrEqual(0);
        expect(await realized(id)).toBeCloseTo(-200_026, 4);

        const { rows: [sf] } = await pool.query<{ shortfall: string }>(
            `SELECT le.metadata->>'shortfall' AS shortfall FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
             WHERE w.match_id = $1 AND w.user_id = $2 AND le.entry_type = 'LIQUIDATION_SHORTFALL'`, [id, alice]);
        expect(Number(sf.shortfall)).toBeCloseTo(10 * (100_013 - exit) - 200_026, 4);
    });

    it("SPOT: the score and the wallets close at the same walked price", async () => {
        const id = await matchWith("1100000.00000000");
        await inMatch(id, "BUY", "10.00000000");
        const afterOpen = await usdBalance(id);

        await completeMatch(id);

        const exit = await closingPrice(id);
        expect(exit).toBeCloseTo(WALKED_SELL, 4);
        expect(await usdBalance(id)).toBeCloseTo(afterOpen + 10 * exit * (1 - 0.0005), 4);
    });

    it("a short pays the walk on the ask", async () => {
        enableLeverage();
        const id = await matchWith("300000.00000000");
        await inMatch(id, "SELL", "10.00000000", 5);
        await completeMatch(id);
        expect(await closingPrice(id)).toBeGreaterThan(100_000);
    });

    it("no depth at match end: it still ends, at the touch", async () => {
        enableLeverage();
        const id = await matchWith("300000.00000000");
        await inMatch(id, "BUY", "10.00000000", 5);
        clearReferenceBooks();
        await seedTicker("BTC/USD", "99990", "100000", "100000");

        await completeMatch(id);

        expect(await closingPrice(id)).toBe(99_990);
    });

    it("small positions still close exactly at the touch", async () => {
        enableLeverage();
        const id = await matchWith("100000.00000000");
        await inMatch(id, "BUY", "0.10000000", 5);
        await completeMatch(id);
        expect(await closingPrice(id)).toBe(99_990);
    });
});
