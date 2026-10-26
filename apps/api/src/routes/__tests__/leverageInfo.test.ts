/**
 * leverageInfo.test.ts: GET /leverage?pairId= (leverage PR 6a).
 *
 * The web's only source for "may this user use leverage here, and up to
 * what": the server resolves the model the next order on this pair would
 * trade (resolveTakerMargin: open position's model, match stamp, flag,
 * system user) and the cap (isolatedCap: flag, allowlist, per-mode cap,
 * match stamp, pair ceiling; 1 in solo replay). The web never decides.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";
import { createMatch, acceptMatch } from "../../competitions/matchService";

let app: FastifyInstance;
let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };

const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });
const info = (uid: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/leverage?pairId=${pairId}`, headers: { ...auth(uid), ...headers } });
const flagOn = (extra: Partial<typeof config.leverage> = {}) => Object.assign(config.leverage, {
    enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [], ...extra,
});

async function trader(email?: string): Promise<string> {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "10000.00000000");
    return u.id;
}

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

describe("GET /leverage", () => {
    it("flag off: SPOT, cap 1", async () => {
        const u = await trader();
        const res = await info(u);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            ok: true, pairId, enabled: false, marginMode: "SPOT", cap: 1, mmrBps: 50,
            positionLeverage: null, blockedBy: null, scope: { competitionId: null, matchId: null },
        });
    });

    it("flag on, free-play: ISOLATED, cap 10 (min of the free-play cap and the pair's max)", async () => {
        flagOn();
        const u = await trader();
        expect((await info(u)).json()).toMatchObject({ enabled: true, marginMode: "ISOLATED", cap: 10, positionLeverage: null });
        await pool.query(`UPDATE trading_pairs SET max_leverage = 3 WHERE id = $1`, [pairId]);
        expect((await info(u)).json().cap).toBe(3);
    });

    it("the allowlist: users not on it get 1x", async () => {
        const listed = await trader();
        const other = await trader();
        flagOn({ allowlist: [listed] });
        expect((await info(listed)).json().cap).toBe(10);
        expect((await info(other)).json()).toMatchObject({ marginMode: "ISOLATED", cap: 1 });
    });

    it("an open position's leverage is reported (the selector locks to it)", async () => {
        flagOn();
        const u = await trader();
        await placeOrderWithSnapshot(u, { pairId, side: "BUY", type: "MARKET", qty: "0.00100000", leverage: 5 });
        expect((await info(u)).json()).toMatchObject({ marginMode: "ISOLATED", cap: 10, positionLeverage: "5.00" });
    });

    it("an open SPOT position keeps SPOT even with the flag on", async () => {
        const u = await trader();
        await placeOrderWithSnapshot(u, { pairId, side: "BUY", type: "MARKET", qty: "0.00100000" });
        flagOn();
        expect((await info(u)).json()).toMatchObject({ marginMode: "SPOT", cap: 1 });
    });

    it("resting orders of the other model are reported as blockedBy", async () => {
        const u = await trader();
        await placeOrderWithSnapshot(u, { pairId, side: "BUY", type: "LIMIT", qty: "0.00100000", limitPrice: "70000" });
        flagOn();
        expect((await info(u)).json()).toMatchObject({ marginMode: "ISOLATED", blockedBy: "spot_orders_open" });
    });

    it("in a match: the cap stamped on the match at accept, not the current config", async () => {
        flagOn();
        const a = await trader();
        const b = await trader();
        const m = await createMatch(a, b, 24, [pairId]);
        await acceptMatch(m.id, b); // stamped 5x
        flagOn({ maxMatch: 2 });
        expect((await info(a)).json()).toMatchObject({ marginMode: "ISOLATED", cap: 5, scope: { matchId: m.id } });
    });

    it("a competition: 1x", async () => {
        flagOn();
        const u = await trader();
        const { rows: [c] } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at) VALUES ('c', now(), now() + interval '1 day') RETURNING id`);
        expect((await info(u, { "x-competition-id": c.id })).json()).toMatchObject({
            marginMode: "ISOLATED", cap: 1, scope: { competitionId: c.id, matchId: null },
        });
    });

    it("bots and @system.local users: SPOT", async () => {
        flagOn();
        const bot = await trader("mm@system.local");
        expect((await info(bot)).json()).toMatchObject({ marginMode: "SPOT", cap: 1 });
    });

    it("an active solo replay session on the pair: 1x", async () => {
        flagOn();
        const u = await trader();
        await pool.query(
            `INSERT INTO replay_sessions (user_id, pair_id, current_ts, end_ts, speed, is_active, is_paused, timeframe)
             VALUES ($1, $2, now() - interval '1 day', now(), 1, true, false, '1m')`, [u, pairId]);
        expect((await info(u)).json()).toMatchObject({ cap: 1 });
    });

    it("a non-tradable pair is a 400, a missing pairId is a 400, no auth is a 401", async () => {
        const u = await trader();
        await pool.query(`UPDATE trading_pairs SET symbol = 'XYZ/USD' WHERE id = $1`, [pairId]);
        resetMarketDataPairIdCache();
        expect((await info(u)).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: "/leverage", headers: auth(u) })).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: `/leverage?pairId=${pairId}` })).statusCode).toBe(401);
    });
});
