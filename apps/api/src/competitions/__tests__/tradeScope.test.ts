/**
 * tradeScope.test.ts: an order lands in the wallet the request names.
 *
 * During a live match the same user can trade the match or practice on
 * free-play. The request says which (`scope`); the server never infers it from
 * "this user is in a match", and a scope it can't honor is refused, never
 * rerouted. Real matches, real wallets, the real HTTP routes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { createMatch, acceptMatch, forfeitMatch } from "../matchService";

const FREE_USD = "100000.00000000";
const QTY = "0.01000000";

let app: FastifyInstance;
let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let alice: string;
let bob: string;
let matchId: string;
const saved = { ...config.leverage };

const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

function postOrder(uid: string, scope: unknown, extra: Record<string, unknown> = {}) {
    return app.inject({
        method: "POST", url: "/orders",
        headers: { ...auth(uid), "idempotency-key": crypto.randomUUID() },
        payload: { pairId, side: "BUY", type: "MARKET", qty: QTY, ...(scope === undefined ? {} : { scope }), ...extra },
    });
}

function postTrigger(uid: string, scope: unknown) {
    return app.inject({
        method: "POST", url: "/v1/triggers", headers: auth(uid),
        payload: { pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "99000", qty: QTY, ...(scope === undefined ? {} : { scope }) },
    });
}

function postOco(uid: string, scope: unknown) {
    const leg = (kind: string, triggerPrice: string) => ({ kind, side: "SELL", triggerPrice, qty: QTY });
    return app.inject({
        method: "POST", url: "/v1/oco", headers: auth(uid),
        payload: { pairId, legA: leg("STOP_MARKET", "70000"), legB: leg("TAKE_PROFIT_MARKET", "99000"), ...(scope === undefined ? {} : { scope }) },
    });
}

/** The user's USD balances: free-play and in the match. */
async function usd(uid: string): Promise<{ free: string; match: string | null }> {
    const { rows } = await pool.query<{ balance: string; match_id: string | null }>(
        `SELECT balance::text, match_id FROM wallets WHERE user_id = $1 AND asset_id = $2`, [uid, usdAssetId],
    );
    return {
        free: rows.find((r) => r.match_id === null)!.balance,
        match: rows.find((r) => r.match_id === matchId)?.balance ?? null,
    };
}

const orderRows = async (uid: string) => (await pool.query<{ match_id: string | null }>(
    `SELECT match_id FROM orders WHERE user_id = $1 ORDER BY created_at`, [uid],
)).rows.map((r) => r.match_id);

const positionScopes = async (uid: string, scope?: string) => {
    const res = await app.inject({ method: "GET", url: `/positions${scope ? `?scope=${scope}` : ""}`, headers: auth(uid) });
    expect(res.statusCode).toBe(200);
    return (res.json().positions as { pair_id: string; base_qty: string }[]).map((p) => p.base_qty);
};

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
    alice = (await createTestUser(pool)).id;
    bob = (await createTestUser(pool)).id;
    for (const u of [alice, bob]) await createTestWallets(pool, u, btcAssetId, usdAssetId, "0.00000000", FREE_USD);
    const match = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(match.id, bob);
    matchId = match.id;
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe("POST /orders: the request must name its scope", () => {
    it("no scope: 400 scope_required, with the words an old tab shows, and nothing placed", async () => {
        const res = await postOrder(alice, undefined);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: "scope_required", message: "TRADR was updated — refresh to continue" });
        expect(await orderRows(alice)).toEqual([]);
    });

    it("not in a match, no scope: still 400", async () => {
        const carol = (await createTestUser(pool)).id;
        await createTestWallets(pool, carol, btcAssetId, usdAssetId, "0.00000000", FREE_USD);
        expect((await postOrder(carol, undefined)).json().error).toBe("scope_required");
    });

    it("a malformed scope: 400, nothing placed", async () => {
        expect((await postOrder(alice, "everything")).statusCode).toBe(400);
        expect(await orderRows(alice)).toEqual([]);
    });
});

describe("an order lands in the wallet the request names", () => {
    it("MATCH during a match: the match wallet moves, free-play doesn't", async () => {
        const before = await usd(alice);
        const res = await postOrder(alice, matchId);
        expect(res.statusCode).toBe(201);
        const after = await usd(alice);
        expect(after.free).toBe(before.free);
        expect(after.match).not.toBe(before.match);
        expect(await orderRows(alice)).toEqual([matchId]);
    });

    it("PRACTICE during a match: free-play moves, the match wallet doesn't", async () => {
        const before = await usd(alice);
        const res = await postOrder(alice, "free");
        expect(res.statusCode).toBe(201);
        const after = await usd(alice);
        expect(after.match).toBe(before.match);
        expect(after.free).not.toBe(before.free);
        expect(await orderRows(alice)).toEqual([null]);
    });

    it("switching back and forth mid-session: each order follows its own request", async () => {
        for (const scope of [matchId, "free", matchId, "free"]) {
            expect((await postOrder(alice, scope)).statusCode).toBe(201);
        }
        expect(await orderRows(alice)).toEqual([matchId, null, matchId, null]);
    });

    it("positions stay apart: each scope reads its own", async () => {
        await postOrder(alice, matchId);
        await postOrder(alice, "free", { qty: "0.02000000" });
        expect(await positionScopes(alice, matchId)).toEqual([QTY]);
        expect(await positionScopes(alice, "free")).toEqual(["0.02000000"]);
    });

    it("GET /positions with no scope is free-play, match or no match", async () => {
        await postOrder(alice, matchId);
        expect(await positionScopes(alice)).toEqual([]);
    });

    it("a practice close can't touch the match position", async () => {
        await postOrder(alice, matchId);
        const res = await postOrder(alice, "free", { side: "SELL", reduceOnly: true });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("reduce_only_no_position");
        expect(await positionScopes(alice, matchId)).toEqual([QTY]);
    });

    it("practice trading leaves the match's live P&L alone", async () => {
        await postOrder(alice, "free");
        const { rows } = await pool.query(`SELECT 1 FROM positions WHERE match_id = $1`, [matchId]);
        expect(rows).toEqual([]);
    });
});

describe("a scope that can't be honored is refused, never rerouted", () => {
    it("the match ended: match_ended, and free-play is untouched", async () => {
        await forfeitMatch(matchId, bob);
        const before = await usd(alice);
        const res = await postOrder(alice, matchId);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("match_ended");
        expect((await usd(alice)).free).toBe(before.free);
        expect(await orderRows(alice)).toEqual([]);
    });

    it("the match hasn't been accepted yet: refused", async () => {
        const carol = (await createTestUser(pool)).id;
        const dave = (await createTestUser(pool)).id;
        for (const u of [carol, dave]) await createTestWallets(pool, u, btcAssetId, usdAssetId, "0.00000000", FREE_USD);
        const pending = await createMatch(carol, dave, 24, [pairId]);
        expect((await postOrder(carol, pending.id)).statusCode).toBe(409);
        expect(await orderRows(carol)).toEqual([]);
    });

    it("another player's match: forbidden", async () => {
        const carol = (await createTestUser(pool)).id;
        await createTestWallets(pool, carol, btcAssetId, usdAssetId, "0.00000000", FREE_USD);
        expect((await postOrder(carol, matchId)).statusCode).toBe(403);
        expect(await orderRows(carol)).toEqual([]);
    });

    it("a match that doesn't exist: forbidden", async () => {
        expect((await postOrder(alice, crypto.randomUUID())).statusCode).toBe(403);
    });

    it("free while a match starts: the order stays in free-play, as asked", async () => {
        const carol = (await createTestUser(pool)).id;
        const dave = (await createTestUser(pool)).id;
        for (const u of [carol, dave]) await createTestWallets(pool, u, btcAssetId, usdAssetId, "0.00000000", FREE_USD);
        const m = await createMatch(carol, dave, 24, [pairId]);
        await acceptMatch(m.id, dave);  // started between the page's render and the click
        expect((await postOrder(carol, "free")).statusCode).toBe(201);
        expect(await orderRows(carol)).toEqual([null]);
    });
});

describe.each([
    ["POST /v1/triggers", postTrigger, 1],
    ["POST /v1/oco", postOco, 2],
] as const)("%s", (_name, post, legs) => {
    const triggerScopes = async () => (await pool.query<{ match_id: string | null }>(
        `SELECT match_id FROM trigger_orders WHERE user_id = $1`, [alice],
    )).rows.map((r) => r.match_id);

    it("no scope: 400, nothing created", async () => {
        const res = await post(alice, undefined);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("scope_required");
        expect(await triggerScopes()).toEqual([]);
    });

    it("the match: the trigger belongs to the match", async () => {
        await postOrder(alice, matchId);
        expect((await post(alice, matchId)).statusCode).toBe(201);
        expect(await triggerScopes()).toEqual(Array(legs).fill(matchId));
    });

    it("free during a match: the trigger belongs to free-play", async () => {
        await postOrder(alice, "free");
        expect((await post(alice, "free")).statusCode).toBe(201);
        expect(await triggerScopes()).toEqual(Array(legs).fill(null));
    });

    it("an ended match: refused", async () => {
        await forfeitMatch(matchId, bob);
        expect((await post(alice, matchId)).statusCode).toBe(409);
        expect(await triggerScopes()).toEqual([]);
    });
});

describe("GET /leverage follows the scope", () => {
    const cap = async (scope?: string) => {
        const res = await app.inject({
            method: "GET", url: `/leverage?pairId=${pairId}${scope ? `&scope=${scope}` : ""}`, headers: auth(alice),
        });
        expect(res.statusCode).toBe(200);
        return res.json() as { cap: number; scope: { matchId: string | null } };
    };

    beforeEach(() => {
        Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [] });
    });

    it("free during a match: the free-play cap", async () => {
        const m2 = await createMatch(bob, (await createTestUser(pool)).id, 24, [pairId]).catch(() => null);
        expect(m2).toBeNull();  // one match at a time: bob is still in matchId
        expect((await cap("free")).scope.matchId).toBeNull();
    });

    it("no scope: free-play, never inferred from the match", async () => {
        expect((await cap()).scope.matchId).toBeNull();
    });

    it("the match: its scope", async () => {
        expect((await cap(matchId)).scope.matchId).toBe(matchId);
    });
});
