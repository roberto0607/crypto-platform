/**
 * The market maker keeps quoting with a short open (QA F5 fix, buying power).
 *
 * The 2× buying-power check counts resting short sells and open shorts. The
 * MM bot rests a sell ladder and can end up short; if the check rejected its
 * quotes the book would empty. System users (the bot ids, @system.local) are
 * exempt. This runs the REAL job against the real DB and order pipeline; only
 * the Kraken snapshot is stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const snapshot = vi.hoisted(() => ({ last: "50000" }));
vi.mock("../../../market/snapshotStore", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../market/snapshotStore")>();
    return {
        ...actual,
        getSnapshot: vi.fn(async () => ({
            bid: snapshot.last, ask: snapshot.last, last: snapshot.last,
            ts: new Date().toISOString(), source: "live" as const,
        })),
    };
});

import { pool } from "../../../db/pool";
import { config } from "../../../config";
import { resetTestData, ensureMigrations } from "../../../testing/resetDb";
import { createTestAssetAndPair, createTestUser, createTestWallets } from "../../../testing/fixtures";
import { clearReferenceBooks } from "../../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../../../trading/phase6OrderService";
import { marketMakerJob, __resetMarketMakerForTest } from "../marketMakerJob";
import type { JobContext } from "../../jobTypes";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
const ctx = { pool, logger, signal: new AbortController().signal } as unknown as JobContext;

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

/**
 * Leave the bot short 50 BTC with $1M — buying power ≈ 1M − 2×50×50k ≈ −4M.
 * Balances only: the resting quotes' holds (reserved) must stay intact.
 */
async function putBotShort() {
    await pool.query(`UPDATE wallets SET balance = '-50' WHERE user_id = $1 AND asset_id = $2`, [config.botUserId, btcAssetId]);
    await pool.query(`UPDATE wallets SET balance = '1000000' WHERE user_id = $1 AND asset_id = $2`, [config.botUserId, usdAssetId]);
}

async function openBotQuotes() {
    const { rows } = await pool.query<{ side: string; n: number }>(
        `SELECT side, count(*)::int AS n FROM orders
         WHERE user_id = $1 AND pair_id = $2 AND status = 'OPEN' GROUP BY side`,
        [config.botUserId, pairId],
    );
    return Object.fromEntries(rows.map((r) => [r.side, r.n]));
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    __resetMarketMakerForTest();
    logger.warn.mockClear();
    snapshot.last = "50000";
    const assets = await createTestAssetAndPair(pool); // BTC/USD — a pair the bot quotes
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    await pool.query(
        `INSERT INTO users (id, email, email_normalized, password_hash, role)
         VALUES ($1, 'mmbot@system.local', 'mmbot@system.local', 'x', 'USER')
         ON CONFLICT (id) DO NOTHING`,
        [config.botUserId],
    );
});

describe("market maker vs buying power", () => {
    it("requotes its full ladder (3 bids + 3 asks) while short", async () => {
        await marketMakerJob.run(ctx); // boot: funds wallets, quotes
        expect(await openBotQuotes()).toEqual({ BUY: 3, SELL: 3 });

        await putBotShort();
        snapshot.last = "50100"; // 20 bps move → cancel + requote
        await marketMakerJob.run(ctx);

        expect(logger.warn.mock.calls.filter(([, msg]) => msg === "mm_place_error")).toEqual([]);
        expect(await openBotQuotes()).toEqual({ BUY: 3, SELL: 3 });
    });

    it("control: the same wallets on a normal account can't rest that sell", async () => {
        const user = (await createTestUser(pool)).id;
        await createTestWallets(pool, user, btcAssetId, usdAssetId, "-50.00000000", "1000000.00000000");
        await expect(
            placeOrderWithSnapshot(user, { pairId, side: "SELL", type: "LIMIT", qty: "0.50000000", limitPrice: "50100" }),
        ).rejects.toThrow(/insufficient_balance/);
    });

    it("any @system.local account is exempt too", async () => {
        const ops = (await createTestUser(pool, { email: "ops@system.local" })).id;
        await createTestWallets(pool, ops, btcAssetId, usdAssetId, "-50.00000000", "1000000.00000000");
        const { order } = await placeOrderWithSnapshot(ops, { pairId, side: "SELL", type: "LIMIT", qty: "0.50000000", limitPrice: "50100" });
        expect(order.status).toBe("OPEN");
    });
});
