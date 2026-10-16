/**
 * liquidationRaces.test.ts: a position is liquidated at most once, and never
 * after something else closed it (leverage PR 4, design §2.3 "Races", §7).
 *
 * Each race is staged with a lock held by the test, so both sides are really
 * queued on Postgres at the same time (checked in pg_stat_activity), then
 * released, in both orders where the order matters:
 *
 *   user close  vs liquidation   (pair lock: whoever is first wins; the other
 *                                 sees a flat position or a new episode)
 *   TP/SL       vs liquidation
 *   two engines / two ticks       (two engines confirm the same breach; one
 *                                 closes, the other no-ops)
 *   match end   vs liquidation   (match end first, liquidation first, and
 *                                 each one holding the match wallets while
 *                                 the other waits on them)
 *
 * Invariant checked everywhere: one MARGIN_RELEASE for the episode (exactly
 * one close), at most one EXECUTED row, no negative balance.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
    notifyPositionLiquidated: vi.fn().mockResolvedValue(undefined),
}));

import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { fireTrigger } from "../../triggers/triggerEngine";
import { createMatch, acceptMatch, completeMatch } from "../../competitions/matchService";
import { LiquidationEngine, type PairEvaluation } from "../liquidationEngine";
import type { LiquidationMode } from "../leverageConfig";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;

const savedLeverage = { ...config.leverage };
function setup(mode: LiquidationMode) {
    Object.assign(config.leverage, {
        enabled: true, liquidationMode: mode, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
    });
}

const SIZE = "0.00602409"; // $50 at 10x at 83,000
const CAPITAL = new Decimal("50000");

async function trader(usd = "100000.00000000"): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

const marketOrder = (uid: string, side: "BUY" | "SELL", qty: string, leverage?: number, matchId: string | null = null) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage }, undefined, undefined, null, matchId);

const liquidate = (uid: string, epoch: number, qty = SIZE, matchId: string | null = null) =>
    placeOrderWithSnapshot(
        uid, { pairId, side: "SELL", type: "MARKET", qty },
        undefined, undefined, null, matchId, "liquidation", { epoch, side: "LONG" },
    );

/** Hold a row lock in its own transaction until the returned release() is called. */
async function holdLock(sql: string, params: unknown[]): Promise<() => Promise<void>> {
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query(sql, params);
    return async () => {
        await client.query("COMMIT");
        client.release();
    };
}
const holdPairLock = () => holdLock(`SELECT id FROM trading_pairs WHERE id = $1 FOR UPDATE`, [pairId]);

/** Wait until `n` backends of this database are waiting on a lock. */
async function waitBlocked(n: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (Number(rows[0].n) >= n) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} blocked backends (have ${rows[0].n})`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

/** How many times episode `epoch` of uid's position (in a scope) was closed: its MARGIN_RELEASE entries. */
async function closesOf(uid: string, epoch: number, matchId: string | null = null): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
         WHERE w.user_id = $1 AND w.match_id IS NOT DISTINCT FROM $2 AND w.competition_id IS NULL
           AND l.entry_type = 'MARGIN_RELEASE' AND (l.metadata->>'epoch')::int = $3`,
        [uid, matchId, epoch],
    );
    return Number(rows[0].n);
}

async function executedRows(uid: string): Promise<{ position_epoch: number; match_id: string | null }[]> {
    const { rows } = await pool.query<{ position_epoch: number; match_id: string | null }>(
        `SELECT position_epoch, match_id FROM liquidations WHERE user_id = $1 AND mode = 'EXECUTED'`, [uid]);
    return rows;
}

async function noNegativeBalances(): Promise<void> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM wallets w JOIN assets a ON a.id = w.asset_id WHERE a.symbol = 'USD' AND w.balance < 0`);
    expect(rows[0].n).toBe("0");
}

async function position(uid: string, matchId: string | null = null) {
    const { rows } = await pool.query<{ base_qty: string; epoch: number; isolated_margin: string }>(
        `SELECT base_qty::text, epoch, isolated_margin::text FROM positions
         WHERE user_id = $1 AND pair_id = $2 AND competition_id IS NULL AND match_id IS NOT DISTINCT FROM $3`,
        [uid, pairId, matchId],
    );
    return rows[0];
}

const reasonOf = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? (r.reason as { reason?: string; message: string }).reason ?? (r.reason as Error).message : "ok";

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
    seedReferenceBook(pairId, "83000", "83000");
    setup("execute");
});

afterEach(() => {
    Object.assign(config.leverage, savedLeverage, { allowlist: [...savedLeverage.allowlist] });
});

describe("the user's close vs a liquidation", () => {
    it("user's close queued first: it closes; the liquidation finds the position flat and does nothing", async () => {
        const u = await trader();
        await marketOrder(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");

        const release = await holdPairLock();
        const close = marketOrder(u, "SELL", SIZE);
        await waitBlocked(1);
        const liq = liquidate(u, 1);
        await waitBlocked(2);
        await release();
        const [c, l] = await Promise.allSettled([close, liq]);

        expect(c.status).toBe("fulfilled");
        expect(reasonOf(l)).toBe("flat");
        expect(await closesOf(u, 1)).toBe(1);
        expect(await executedRows(u)).toEqual([]);
        expect((await position(u)).base_qty).toBe("0.00000000");
        await noNegativeBalances();
    });

    it("liquidation queued first: it closes; the user's sell then trades on a flat position (a new 1x short, epoch 2)", async () => {
        const u = await trader();
        await marketOrder(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");

        const release = await holdPairLock();
        const liq = liquidate(u, 1);
        await waitBlocked(1);
        const close = marketOrder(u, "SELL", SIZE);
        await waitBlocked(2);
        await release();
        const [l, c] = await Promise.allSettled([liq, close]);

        expect(l.status).toBe("fulfilled");
        expect(c.status).toBe("fulfilled");
        expect(await closesOf(u, 1)).toBe(1);
        expect(await executedRows(u)).toEqual([{ position_epoch: 1, match_id: null }]);
        // Not a second close of epoch 1: a manual order isn't reduce-only.
        expect(await position(u)).toMatchObject({ base_qty: "-" + SIZE, epoch: 2 });
        await noNegativeBalances();
    });

    it("unstaged, several users at once: each episode is closed exactly once", async () => {
        const users = await Promise.all([1, 2, 3, 4].map(() => trader()));
        for (const u of users) await marketOrder(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");

        await Promise.allSettled(users.flatMap((u) => [marketOrder(u, "SELL", SIZE), liquidate(u, 1)]));
        for (const u of users) {
            expect(await closesOf(u, 1)).toBe(1);
            expect((await executedRows(u)).length).toBeLessThanOrEqual(1);
        }
        await noNegativeBalances();
    });
});

describe("a TP/SL vs a liquidation", () => {
    it("stop fires first: the liquidation is a no-op", async () => {
        const u = await trader();
        await marketOrder(u, "BUY", SIZE, 10);
        const sl = await createTriggerOrder({ userId: u, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "76000", qty: SIZE, matchId: null });
        seedReferenceBook(pairId, "75000", "75000");

        await fireTrigger(sl, { last: "75000" });
        await expect(liquidate(u, 1)).rejects.toMatchObject({ reason: "flat" });
        expect(await closesOf(u, 1)).toBe(1);
        expect(await executedRows(u)).toEqual([]);
    });

    it("liquidation first: the stop is canceled in its transaction and never trades", async () => {
        const u = await trader();
        await marketOrder(u, "BUY", SIZE, 10);
        const sl = await createTriggerOrder({ userId: u, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "76000", qty: SIZE, matchId: null });
        seedReferenceBook(pairId, "75000", "75000");

        await liquidate(u, 1);
        await fireTrigger(sl, { last: "75000" }); // a tick that saw the old state
        const { rows } = await pool.query<{ status: string; derived_order_id: string | null }>(
            `SELECT status, derived_order_id FROM trigger_orders WHERE id = $1`, [sl.id]);
        expect(rows[0]).toEqual({ status: "CANCELED", derived_order_id: null });
        expect(await closesOf(u, 1)).toBe(1);
        expect((await position(u)).base_qty).toBe("0.00000000");
    });

    it("both queued on the pair lock: exactly one close", async () => {
        const u = await trader();
        await marketOrder(u, "BUY", SIZE, 10);
        const sl = await createTriggerOrder({ userId: u, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "76000", qty: SIZE, matchId: null });
        seedReferenceBook(pairId, "75000", "75000");

        const release = await holdPairLock();
        const trig = fireTrigger(sl, { last: "75000" });
        await waitBlocked(1);
        const liq = liquidate(u, 1);
        await waitBlocked(2);
        await release();
        await Promise.allSettled([trig, liq]);

        expect(await closesOf(u, 1)).toBe(1);
        expect((await position(u)).base_qty).toBe("0.00000000");
        await noNegativeBalances();
    });
});

describe("two engines / two ticks at once", () => {
    const newEngine = () => new LiquidationEngine({ feedStatus: () => "ok", useLeadership: false });
    const sum = (rs: PairEvaluation[], k: "executed" | "noop" | "logged") =>
        rs.reduce((n, r) => n + (r.status === "evaluated" ? r[k] : 0), 0);

    it("two engines confirm the same breaches; each position is liquidated once, the other engine no-ops", async () => {
        const users = await Promise.all([1, 2, 3].map(() => trader()));
        for (const u of users) await marketOrder(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");

        const [e1, e2] = [newEngine(), newEngine()];
        const t0 = Date.now();
        await Promise.all([e1.evaluatePair(pairId, t0), e2.evaluatePair(pairId, t0)]);
        const results = await Promise.all([e1.evaluatePair(pairId, t0 + 600), e2.evaluatePair(pairId, t0 + 600)]);

        expect(sum(results, "executed")).toBe(3);
        expect(sum(results, "noop")).toBe(3);
        for (const u of users) {
            expect(await closesOf(u, 1)).toBe(1);
            expect(await executedRows(u)).toHaveLength(1);
        }
        await noNegativeBalances();
    });

    it("one engine, two ticks at once: the second evaluation is skipped while the first is in flight", async () => {
        const u = await trader();
        await marketOrder(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");
        const e = newEngine();
        const t0 = Date.now();
        await e.evaluatePair(pairId, t0);
        const [a, b] = await Promise.all([e.evaluatePair(pairId, t0 + 600), e.evaluatePair(pairId, t0 + 600)]);
        expect([a.status, b.status].sort()).toEqual(["busy", "evaluated"]);
        expect(await closesOf(u, 1)).toBe(1);
    });

    it("log_only: two engines write one row per episode", async () => {
        setup("log_only");
        const users = await Promise.all([1, 2].map(() => trader()));
        for (const u of users) await marketOrder(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "75000", "75000");

        const [e1, e2] = [newEngine(), newEngine()];
        const t0 = Date.now();
        await Promise.all([e1.evaluatePair(pairId, t0), e2.evaluatePair(pairId, t0)]);
        const results = await Promise.all([e1.evaluatePair(pairId, t0 + 600), e2.evaluatePair(pairId, t0 + 600)]);
        expect(sum(results, "logged")).toBe(2);
        const { rows } = await pool.query(`SELECT user_id FROM liquidations WHERE mode = 'LOG_ONLY'`);
        expect(rows).toHaveLength(2);
        for (const u of users) expect((await position(u)).base_qty).toBe(SIZE);
    });
});

describe("match end vs a liquidation (ISOLATED match, 5x)", () => {
    let alice: string;
    let bob: string;
    let matchId: string;
    // 0.1 BTC at 5x at 83,000: margin 1,660, fee 4.15, liq 66,733.67.
    const QTY = "0.10000000";

    beforeEach(async () => {
        alice = await trader();
        bob = await trader();
        const m = await createMatch(alice, bob, 24, [pairId]);
        await acceptMatch(m.id, bob);
        matchId = m.id;
        await marketOrder(alice, "BUY", QTY, 5, matchId);
        seedReferenceBook(pairId, "66500", "66500"); // past alice's liq (66,733.67), short of bankruptcy (66,400)
    });

    const liquidateInMatch = () => liquidate(alice, 1, QTY, matchId);
    const matchStatus = async () => (await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [matchId])).rows[0].status;
    const aliceUsd = async () => (await pool.query<{ balance: string; closed_at: string | null }>(
        `SELECT balance::text, closed_at::text FROM wallets WHERE user_id = $1 AND match_id = $2 AND asset_id = $3`,
        [alice, matchId, usdAssetId])).rows[0];
    const syntheticCloses = async () => (await pool.query(
        `SELECT 1 FROM orders WHERE user_id = $1 AND match_id = $2 AND source IS NULL AND status = 'FILLED' AND side = 'SELL'`,
        [alice, matchId])).rows.length;

    async function oneCloseAndSettled() {
        expect(await matchStatus()).toBe("COMPLETED");
        expect(await closesOf(alice, 1, matchId)).toBe(1);
        expect((await position(alice, matchId)).base_qty).toBe("0.00000000");
        expect((await aliceUsd()).closed_at).not.toBeNull();
        await noNegativeBalances();
    }

    it("match end in flight (holding the pair and the wallets): the waiting liquidation gets match_ended", async () => {
        // Stall match end on alice's position row, after it has taken what it
        // locks before positions; the liquidation then queues behind it.
        const release = await holdLock(
            `SELECT 1 FROM positions WHERE user_id = $1 AND match_id = $2 FOR UPDATE`, [alice, matchId]);
        const end = completeMatch(matchId);
        await waitBlocked(1);
        const liq = liquidateInMatch();
        await waitBlocked(2);
        await release();
        const [e, l] = await Promise.allSettled([end, liq]);

        expect(e.status).toBe("fulfilled");
        expect(reasonOf(l)).toBe("match_ended");
        expect(await executedRows(alice)).toEqual([]);
        expect(await syntheticCloses()).toBe(1);
        await oneCloseAndSettled();
    });

    it("liquidation first: it closes; match end finds the position flat and only settles the wallets", async () => {
        // Hold the match row as match end does (FOR NO KEY UPDATE): completeMatch queues on it.
        const release = await holdLock(`SELECT id FROM matches WHERE id = $1 FOR NO KEY UPDATE`, [matchId]);
        const end = completeMatch(matchId);
        await waitBlocked(1);
        const liq = await liquidateInMatch();
        await release();
        await end;

        expect(await executedRows(alice)).toEqual([{ position_epoch: 1, match_id: matchId }]);
        expect(await syntheticCloses()).toBe(0);
        await oneCloseAndSettled();
        // The score is the wallet after the liquidation: capital − open fee − margin + what came back.
        const usd = new Decimal((await aliceUsd()).balance);
        expect(usd.toFixed(8)).toBe(CAPITAL.minus("4.15").minus("1660").plus(liq.liquidation!.returnedEquity).toFixed(8));
        const { rows } = await pool.query<{ challenger_pnl_pct: string }>(`SELECT challenger_pnl_pct::text FROM matches WHERE id = $1`, [matchId]);
        expect(Number(rows[0].challenger_pnl_pct)).toBeCloseTo(usd.minus(CAPITAL).div(CAPITAL).mul(100).toNumber(), 6);
    });

    it("liquidation in flight (holding the pair and the wallets): match end waits, then finds the position flat", async () => {
        const release = await holdLock(
            `SELECT 1 FROM positions WHERE user_id = $1 AND match_id = $2 FOR UPDATE`, [alice, matchId]);
        const liq = liquidateInMatch();       // pair → wallets → (waits on the position row)
        await waitBlocked(1);
        const end = completeMatch(matchId);   // waits behind it
        await waitBlocked(2);
        await release();
        const [l, e] = await Promise.allSettled([liq, end]);

        expect(l.status).toBe("fulfilled");
        expect(e.status).toBe("fulfilled");
        expect(await executedRows(alice)).toHaveLength(1);
        expect(await syntheticCloses()).toBe(0);
        await oneCloseAndSettled();
    });

    it("an ordinary in-match close in flight while match end waits: no deadlock either", async () => {
        const release = await holdLock(
            `SELECT 1 FROM positions WHERE user_id = $1 AND match_id = $2 FOR UPDATE`, [alice, matchId]);
        const close = marketOrder(alice, "SELL", QTY, undefined, matchId);
        await waitBlocked(1);
        const end = completeMatch(matchId);
        await waitBlocked(2);
        await release();
        const [c, e] = await Promise.allSettled([close, end]);

        expect(c.status).toBe("fulfilled");
        expect(e.status).toBe("fulfilled");
        expect(await closesOf(alice, 1, matchId)).toBe(1); // the user's close; match end found it flat
        expect(await matchStatus()).toBe("COMPLETED");
    });

    it("unstaged: match end and the liquidation at once, either may win, one close", async () => {
        const [e, l] = await Promise.allSettled([completeMatch(matchId), liquidateInMatch()]);
        expect(e.status).toBe("fulfilled");
        if (l.status === "rejected") expect(["match_ended", "flat"]).toContain(reasonOf(l));
        expect(await executedRows(alice)).toHaveLength(l.status === "fulfilled" ? 1 : 0);
        expect(await syntheticCloses()).toBe(l.status === "fulfilled" ? 0 : 1);
        await oneCloseAndSettled();
    });

    it("the engine liquidates a match position past its liq price (it no longer rides to match end)", async () => {
        const e = new LiquidationEngine({ feedStatus: () => "ok", useLeadership: false });
        const t0 = Date.now();
        await e.evaluatePair(pairId, t0);
        expect(await e.evaluatePair(pairId, t0 + 600)).toMatchObject({ executed: 1 });
        expect(await executedRows(alice)).toEqual([{ position_epoch: 1, match_id: matchId }]);
        expect((await aliceUsd()).closed_at).toBeNull(); // the match goes on
        await completeMatch(matchId);
        expect(await syntheticCloses()).toBe(0);
        await oneCloseAndSettled();
    });
});
