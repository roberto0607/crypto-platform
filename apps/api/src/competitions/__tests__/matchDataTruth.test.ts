/**
 * matchDataTruth.test.ts: what the match screen reads must be true.
 *
 * - Open orders and triggers: `?scope=<matchId|free>` returns that scope's
 *   rows and nothing else. No scope: every row, for Journal and replay.
 * - GET /v1/matches/active carries live P&L: matches.*_pnl_pct stays 0 until
 *   the match ends, and after a reload no push comes until P&L moves again.
 * - The match.pnl.update gate: a 0.001-point move, at most once a second.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";

const published = vi.hoisted(() => [] as { type: string; data: Record<string, string> }[]);
vi.mock("../../events/matchEvents", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../events/matchEvents")>();
    return {
        ...real,
        publishMatchEvent: (type: string, data: Record<string, string>) => { published.push({ type, data }); },
    };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { evaluateMatchPnlForPair, stopMatchPnlEngine } from "../matchPnlEngine";

const CAPITAL = 100_000;

let app: FastifyInstance;
let pairId: string;
let alice: string;
let bob: string;
let matchId: string;

const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });
const get = (url: string, uid = alice) => app.inject({ method: "GET", url, headers: auth(uid) });

async function insertOrder(scope: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO orders (user_id, pair_id, side, type, limit_price, qty, status, match_id)
         VALUES ($1, $2, 'SELL', 'LIMIT', '90000', '0.1', 'OPEN', $3) RETURNING id`,
        [alice, pairId, scope],
    );
    return rows[0]!.id;
}

async function insertTrigger(scope: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO trigger_orders (user_id, pair_id, kind, side, trigger_price, qty, match_id)
         VALUES ($1, $2, 'TAKE_PROFIT_MARKET', 'SELL', '90000', '0.1', $3) RETURNING id`,
        [alice, pairId, scope],
    );
    return rows[0]!.id;
}

async function openLong(userId: string, qty: string, entry: string): Promise<void> {
    await pool.query(
        `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price, match_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, pairId, qty, entry, matchId],
    );
}

const setPrice = (price: string) => pool.query(`UPDATE trading_pairs SET last_price = $2 WHERE id = $1`, [pairId, price]);

beforeAll(async () => {
    await ensureMigrations();
    app = await buildApp({
        logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
        disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
    });
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetTestData();
    published.length = 0;
    stopMatchPnlEngine();
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    resetMarketDataPairIdCache();
    alice = (await createTestUser(pool)).id;
    bob = (await createTestUser(pool)).id;
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
         VALUES ($1, $2, 24, $3, 'ACTIVE', now() - interval '1 hour', now() + interval '23 hours')
         RETURNING id`,
        [alice, bob, CAPITAL],
    );
    matchId = rows[0]!.id;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe.each([
    ["GET /orders", "/orders?status=OPEN", (b: { orders: { id: string }[] }) => b.orders],
    ["GET /v1/orders", "/v1/orders?status=OPEN", (b: { data: { id: string }[] }) => b.data],
] as const)("%s scope", (_name, url, rowsOf) => {
    const ids = async (query: string) => {
        const res = await get(url + query);
        expect(res.statusCode).toBe(200);
        return (rowsOf as (b: unknown) => { id: string }[])(res.json()).map((r) => r.id);
    };

    it("a free-play order never appears in match scope", async () => {
        const free = await insertOrder(null);
        const inMatch = await insertOrder(matchId);
        expect(await ids(`&scope=${matchId}`)).toEqual([inMatch]);
        expect(await ids(`&scope=${matchId}`)).not.toContain(free);
    });

    it("a match order never appears in free-play scope", async () => {
        const free = await insertOrder(null);
        await insertOrder(matchId);
        expect(await ids("&scope=free")).toEqual([free]);
    });

    it("no scope: every order, as before", async () => {
        const free = await insertOrder(null);
        const inMatch = await insertOrder(matchId);
        expect((await ids("")).sort()).toEqual([free, inMatch].sort());
    });

    it("a bad scope is a 400, never an unfiltered list", async () => {
        await insertOrder(null);
        expect((await get(`${url}&scope=everything`)).statusCode).toBe(400);
    });

    it("another user's match scope shows nothing", async () => {
        await insertOrder(matchId);
        const res = await get(`${url}&scope=${matchId}`, bob);
        expect((rowsOf as (b: unknown) => { id: string }[])(res.json())).toEqual([]);
    });
});

describe("GET /v1/triggers scope", () => {
    const ids = async (query: string) => {
        const res = await get(`/v1/triggers?status=ACTIVE${query}`);
        expect(res.statusCode).toBe(200);
        return (res.json() as { data: { id: string }[] }).data.map((r) => r.id);
    };

    it("a free-play TP never appears in match scope", async () => {
        await insertTrigger(null);
        const inMatch = await insertTrigger(matchId);
        expect(await ids(`&scope=${matchId}`)).toEqual([inMatch]);
    });

    it("a match TP never appears in free-play scope", async () => {
        const free = await insertTrigger(null);
        await insertTrigger(matchId);
        expect(await ids("&scope=free")).toEqual([free]);
    });

    it("no scope: every trigger, as before", async () => {
        const free = await insertTrigger(null);
        const inMatch = await insertTrigger(matchId);
        expect((await ids("")).sort()).toEqual([free, inMatch].sort());
    });

    it("a bad scope is a 400, never an unfiltered list", async () => {
        await insertTrigger(null);
        expect((await get("/v1/triggers?scope=everything")).statusCode).toBe(400);
    });
});

describe("GET /v1/matches/active: P&L right after a reload", () => {
    const activeMatch = async (uid = alice) =>
        (await get("/v1/matches/active", uid)).json().match as { status: string; challenger_pnl_pct: string | null; opponent_pnl_pct: string | null };

    it("returns live P&L, not the row's frozen value", async () => {
        await setPrice("80000");
        await openLong(alice, "1", "70000");   // +10,000 on 100,000
        await openLong(bob, "1", "85000");     //  -5,000
        const m = await activeMatch();
        expect(Number(m.challenger_pnl_pct)).toBeCloseTo(10, 6);
        expect(Number(m.opponent_pnl_pct)).toBeCloseTo(-5, 6);
    });

    it("is right for a reload the publish gate would stay silent on", async () => {
        await setPrice("80000");
        await openLong(alice, "1", "70000");
        await evaluateMatchPnlForPair(pairId);
        published.length = 0;
        await evaluateMatchPnlForPair(pairId);  // same price: no push for a freshly loaded page
        expect(published).toEqual([]);
        expect(Number((await activeMatch()).challenger_pnl_pct)).toBeCloseTo(10, 6);
    });

    it("both players read the same numbers", async () => {
        await setPrice("80000");
        await openLong(alice, "1", "70000");
        expect((await activeMatch(alice)).challenger_pnl_pct).toBe((await activeMatch(bob)).challenger_pnl_pct);
    });

    it("no positions: zero", async () => {
        expect(Number((await activeMatch()).challenger_pnl_pct)).toBe(0);
    });

    it("a P&L read failure still returns the match", async () => {
        const real = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
        vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) =>
            String(args[0]).includes("FROM positions") ? Promise.reject(new Error("boom")) : real(...args)) as never);
        const res = await get("/v1/matches/active");
        expect(res.statusCode).toBe(200);
        expect(res.json().match.id).toBe(matchId);
    });

    it("a PENDING match keeps its row values", async () => {
        await pool.query(`UPDATE matches SET status = 'PENDING' WHERE id = $1`, [matchId]);
        expect((await activeMatch()).status).toBe("PENDING");
        expect((await activeMatch()).challenger_pnl_pct).toBeNull();
    });
});

describe("match.pnl.update publish gate", () => {
    const pushes = () => published.filter((e) => e.type === "match.pnl.update");
    let now: number;

    beforeEach(async () => {
        now = 2_000_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        await setPrice("80000.00");
        await openLong(alice, "1", "80000");
        await evaluateMatchPnlForPair(pairId);  // first push always goes out
        expect(pushes()).toHaveLength(1);
    });

    it("publishes a 0.001-point move ($1 on $100k)", async () => {
        now += 1_001;
        await setPrice("80001.00");
        await evaluateMatchPnlForPair(pairId);
        expect(pushes()).toHaveLength(2);
    });

    it("stays quiet under 0.001 points", async () => {
        now += 1_001;
        await setPrice("80000.50");
        await evaluateMatchPnlForPair(pairId);
        expect(pushes()).toHaveLength(1);
    });

    it("never publishes twice inside a second", async () => {
        now += 999;
        await setPrice("80500.00");
        await evaluateMatchPnlForPair(pairId);
        expect(pushes()).toHaveLength(1);
    });
});
