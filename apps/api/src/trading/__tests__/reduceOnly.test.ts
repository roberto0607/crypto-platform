/**
 * reduceOnly.test.ts: reduce-only orders (leverage PR 6a).
 *
 * A reduce-only order can only shrink the position it closes, in the scope
 * it lands in. POST /orders takes it on MARKET orders only (a LIMIT one
 * comes only from a TP/SL limit fire: reduceOnlyLimit.test.ts). Under the
 * pair lock (which every writer of a position holds: orders, triggers,
 * liquidations, match end, the conversion) the matching engine trims it to
 * what's left of the position,
 * or rejects it (`reduce_only_no_position`) when nothing is left. It never
 * opens or flips a position. The CLOSE button sends it; TP/SL fires use it.
 *
 * Races (staged with the pair lock): a close vs a liquidation, a close vs
 * match end, a stop firing after a liquidation closed its position.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { createMatch, acceptMatch, completeMatch } from "../../competitions/matchService";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { fireTrigger } from "../../triggers/triggerEngine";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };

const flagOn = () => Object.assign(config.leverage, {
    enabled: true, liquidationMode: "execute", maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
});

async function trader(usd = "10000.00000000"): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

const order = (uid: string, side: "BUY" | "SELL", qty: string, opts: { leverage?: number; reduceOnly?: boolean; matchId?: string | null } = {}) =>
    placeOrderWithSnapshot(
        uid, { pairId, side, type: "MARKET", qty, leverage: opts.leverage, reduceOnly: opts.reduceOnly },
        undefined, undefined, null, opts.matchId ?? null,
    );

const liquidate = (uid: string, epoch: number, qty: string, matchId: string | null = null) =>
    placeOrderWithSnapshot(
        uid, { pairId, side: "SELL", type: "MARKET", qty },
        undefined, undefined, null, matchId, "liquidation", { epoch, side: "LONG" },
    );

async function position(uid: string, matchId: string | null = null) {
    const { rows } = await pool.query<{ base_qty: string; epoch: number; margin_mode: string }>(
        `SELECT base_qty::text, epoch, margin_mode FROM positions
         WHERE user_id = $1 AND pair_id = $2 AND competition_id IS NULL AND match_id IS NOT DISTINCT FROM $3`,
        [uid, pairId, matchId]);
    return rows[0];
}

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

async function noNegativeUsd(): Promise<void> {
    const { rows } = await pool.query(`SELECT user_id, balance::text FROM wallets WHERE asset_id = $1 AND balance < 0`, [usdAssetId]);
    expect(rows).toEqual([]);
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
    seedReferenceBook(pairId, "83000", "83000");
    resetMarketDataPairIdCache();
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

// ── The engine ─────────────────────────────────────────────────────────

describe.each([
    ["SPOT (flag off)", () => {}],
    ["ISOLATED (flag on, 10x)", flagOn],
])("reduce-only, %s", (_label, setup) => {
    beforeEach(() => setup());
    const lev = () => (config.leverage.enabled ? 10 : undefined);

    it("closes exactly the position", async () => {
        const u = await trader();
        await order(u, "BUY", "0.01000000", { leverage: lev() });
        const r = await order(u, "SELL", "0.01000000", { reduceOnly: true });
        expect(r.order.qty).toBe("0.01000000");
        expect((await position(u)).base_qty).toBe("0.00000000");
    });

    it("an order larger than the position is trimmed to it: never flips", async () => {
        const u = await trader();
        await order(u, "BUY", "0.01000000", { leverage: lev() });
        const r = await order(u, "SELL", "0.05000000", { reduceOnly: true });
        expect(r.order.qty).toBe("0.01000000");
        expect(r.fills.reduce((s, f) => s + Number(f.qty), 0)).toBeCloseTo(0.01, 8);
        expect((await position(u)).base_qty).toBe("0.00000000");
    });

    it("partial: shrinks without crossing", async () => {
        const u = await trader();
        await order(u, "BUY", "0.01000000", { leverage: lev() });
        await order(u, "SELL", "0.00400000", { reduceOnly: true });
        expect((await position(u)).base_qty).toBe("0.00600000");
    });

    it("no position: rejected, nothing opened", async () => {
        const u = await trader();
        await expect(order(u, "SELL", "0.01000000", { reduceOnly: true })).rejects.toThrow("reduce_only_no_position");
        expect((await position(u))?.base_qty ?? "0.00000000").toBe("0.00000000");
        const { rows } = await pool.query(`SELECT 1 FROM orders WHERE user_id = $1`, [u]);
        expect(rows).toEqual([]);
    });

    it("the same side as the position (it would add): rejected", async () => {
        const u = await trader();
        await order(u, "BUY", "0.01000000", { leverage: lev() });
        await expect(order(u, "BUY", "0.01000000", { reduceOnly: true })).rejects.toThrow("reduce_only_no_position");
        expect((await position(u)).base_qty).toBe("0.01000000");
    });

    it("a short is reduced by a BUY", async () => {
        const u = await trader();
        await order(u, "SELL", "0.01000000", { leverage: lev() });
        const r = await order(u, "BUY", "1.00000000", { reduceOnly: true });
        expect(r.order.qty).toBe("0.01000000");
        expect((await position(u)).base_qty).toBe("0.00000000");
    });
});

describe("a reduce-only LIMIT (a TP/SL limit fire; PR 7)", () => {
    it("the engine accepts it, trimmed to the position (POST /orders still refuses one: see below)", async () => {
        const u = await trader();
        await order(u, "BUY", "0.01000000");
        const r = await placeOrderWithSnapshot(u, { pairId, side: "SELL", type: "LIMIT", qty: "0.05000000", limitPrice: "90000", reduceOnly: true });
        expect(r.order).toMatchObject({ qty: "0.01000000", status: "OPEN" });
        // Resting behaviour: triggers/__tests__/reduceOnlyLimit.test.ts.
    });
});

// ── Races ──────────────────────────────────────────────────────────────

describe("the user's close vs a liquidation (10x long past its liq price)", () => {
    const SIZE = "0.00602409";
    let u: string;
    beforeEach(async () => {
        flagOn();
        u = await trader("1000.00000000");
        await order(u, "BUY", SIZE, { leverage: 10 });
        seedReferenceBook(pairId, "75000", "75000"); // past liq 75,075.38
    });

    it("liquidation first: the reduce-only close finds nothing and is rejected — no new position (the PR 4 gap)", async () => {
        const release = await holdPairLock();
        const liq = liquidate(u, 1, SIZE);
        await waitBlocked(1);
        const close = order(u, "SELL", SIZE, { reduceOnly: true });
        await waitBlocked(2);
        await release();
        await liq;
        await expect(close).rejects.toThrow("reduce_only_no_position");
        const p = await position(u);
        expect(p.base_qty).toBe("0.00000000");
        expect(p.epoch).toBe(1);
        await noNegativeUsd();
    });

    it("close first: it closes; the liquidation is a no-op", async () => {
        const release = await holdPairLock();
        const close = order(u, "SELL", SIZE, { reduceOnly: true });
        await waitBlocked(1);
        const liq = liquidate(u, 1, SIZE);
        await waitBlocked(2);
        await release();
        await close;
        await expect(liq).rejects.toMatchObject({ reason: "flat" });
        expect((await position(u)).base_qty).toBe("0.00000000");
        const { rows } = await pool.query(`SELECT 1 FROM liquidations WHERE mode = 'EXECUTED'`);
        expect(rows).toEqual([]);
    });
});

describe("the user's close vs match end (ISOLATED match)", () => {
    let alice: string;
    let bob: string;
    let matchId: string;
    const QTY = "0.01000000";
    beforeEach(async () => {
        flagOn();
        alice = await trader();
        bob = await trader();
        const m = await createMatch(alice, bob, 24, [pairId]);
        await acceptMatch(m.id, bob);
        matchId = m.id;
        await order(alice, "BUY", QTY, { leverage: 5, matchId });
    });

    it("match end first: the close stops with match_ended and opens nothing", async () => {
        const release = await holdPairLock();
        const end = completeMatch(matchId);
        await waitBlocked(1);
        const close = order(alice, "SELL", QTY, { reduceOnly: true, matchId });
        await waitBlocked(2);
        await release();
        await end;
        await expect(close).rejects.toThrow("match_ended");
        expect((await position(alice, matchId)).base_qty).toBe("0.00000000");
        await noNegativeUsd();
    });

    it("close first: it closes; match end finds the position flat", async () => {
        const release = await holdPairLock();
        const close = order(alice, "SELL", QTY, { reduceOnly: true, matchId });
        await waitBlocked(1);
        const end = completeMatch(matchId);
        await waitBlocked(2);
        await release();
        await close;
        await end;
        const { rows: [m] } = await pool.query(`SELECT status FROM matches WHERE id = $1`, [matchId]);
        expect(m.status).toBe("COMPLETED");
        expect((await position(alice, matchId)).base_qty).toBe("0.00000000");
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM orders WHERE user_id = $1 AND match_id = $2 AND side = 'SELL' AND status = 'FILLED'`,
            [alice, matchId]);
        expect(rows[0].n).toBe(1); // the close only; match end had nothing to force-close
        await noNegativeUsd();
    });
});

describe("a stop firing after a liquidation closed its position", () => {
    it("its order is reduce-only: CANCELED no_position, nothing opened", async () => {
        flagOn();
        const SIZE = "0.00602409";
        const u = await trader("1000.00000000");
        await order(u, "BUY", SIZE, { leverage: 10 });
        const sl = await createTriggerOrder({ userId: u, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "76000", qty: SIZE, matchId: null });
        seedReferenceBook(pairId, "75000", "75000");

        // The stop reads the position (still open), then queues on the pair
        // lock behind the liquidation that closes it.
        const release = await holdPairLock();
        const liq = liquidate(u, 1, SIZE);
        await waitBlocked(1);
        const fire = fireTrigger(sl, { last: "75000" });
        await waitBlocked(2);
        await release();
        await liq;
        await fire;

        const { rows: [t] } = await pool.query(`SELECT status, fail_reason FROM trigger_orders WHERE id = $1`, [sl.id]);
        expect(t).toEqual({ status: "CANCELED", fail_reason: "no_position" });
        const p = await position(u);
        expect(p.base_qty).toBe("0.00000000");
        expect(p.epoch).toBe(1);
    });
});

// ── HTTP ───────────────────────────────────────────────────────────────

describe("POST /orders reduceOnly", () => {
    let app: FastifyInstance;
    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });
    const post = (uid: string, body: Record<string, unknown>) =>
        app.inject({ method: "POST", url: "/orders", headers: auth(uid), payload: { pairId, ...body } });

    beforeAll(async () => {
        app = await buildApp({
            logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
            disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
        });
        await app.ready();
    });
    afterAll(async () => {
        await app.close();
    });

    it("trims through the queue; a flat position is a 400 reduce_only_no_position", async () => {
        const u = await trader();
        expect((await post(u, { side: "BUY", type: "MARKET", qty: "0.01000000" })).statusCode).toBe(201);
        const res = await post(u, { side: "SELL", type: "MARKET", qty: "0.03000000", reduceOnly: true });
        expect(res.statusCode).toBe(201);
        expect(res.json().order.qty).toBe("0.01000000");
        const again = await post(u, { side: "SELL", type: "MARKET", qty: "0.01000000", reduceOnly: true });
        expect(again.statusCode).toBe(400);
        expect(again.json().error).toBe("reduce_only_no_position");
    });

    it("LIMIT + reduceOnly is a 400; a non-boolean reduceOnly is a 400", async () => {
        const u = await trader();
        const limit = await post(u, { side: "SELL", type: "LIMIT", qty: "0.01000000", limitPrice: "90000", reduceOnly: true });
        expect(limit.statusCode).toBe(400);
        const bad = await post(u, { side: "SELL", type: "MARKET", qty: "0.01000000", reduceOnly: "yes" });
        expect(bad.statusCode).toBe(400);
    });

    it("without reduceOnly, a SELL with no position still opens a short (unchanged)", async () => {
        const u = await trader();
        expect((await post(u, { side: "SELL", type: "MARKET", qty: "0.01000000" })).statusCode).toBe(201);
        expect((await position(u)).base_qty).toBe("-0.01000000");
    });
});
