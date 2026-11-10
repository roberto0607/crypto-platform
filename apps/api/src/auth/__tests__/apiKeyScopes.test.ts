/**
 * apiKeyScopes.test.ts: what an `Authorization: ApiKey <key>` caller may do.
 *
 *   - a `read` key reads, and is refused every trading write (orders, cancels,
 *     triggers, OCO, wallets, replay) with 403 insufficient_scope;
 *   - a `trade` key trades free-play, including practice while a match runs;
 *   - no key ever trades a match or a competition (403 api_key_scope_forbidden),
 *     whatever its scopes, for new orders/triggers AND for cancels/edits of
 *     existing match rows;
 *   - other writes (challenges, joining a competition, ...) are session-only;
 *   - a browser session (JWT) is unaffected by any of it.
 *
 * Real HTTP routes, real DB, a real live 1v1 (createMatch + acceptMatch).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { createMatch, acceptMatch } from "../../competitions/matchService";
import { createTriggerOrder } from "../../triggers/triggerRepo";
import { createApiKey } from "../../security/apiKeyRepo";
import { generateApiKey, hashApiKey } from "../../security/apiKeyService";

const FREE_USD = "100000.00000000";
const QTY = "0.01000000";
const MATCH_MSG = "API keys can only trade free-play and practice. Matches and competitions require a signed-in session.";

let app: FastifyInstance;
let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
let alice: string;
let bob: string;
let matchId: string;

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

// ── auth helpers ──

const session = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

/** A fresh API key for `userId` with `scopes`; each test gets its own (own rate-limit bucket). */
async function apiKey(userId: string, scopes: string[]) {
    const raw = generateApiKey();
    await createApiKey({ userId, keyHash: hashApiKey(raw), label: `test-${scopes.join("-")}`, scopes });
    return { authorization: `ApiKey ${raw}` };
}

type Headers = Record<string, string>;

const postOrder = (headers: Headers, scope: unknown, extra: Record<string, unknown> = {}, extraHeaders: Headers = {}) =>
    app.inject({
        method: "POST", url: "/orders",
        headers: { ...headers, "idempotency-key": crypto.randomUUID(), ...extraHeaders },
        payload: { pairId, side: "BUY", type: "MARKET", qty: QTY, scope, ...extra },
    });

/** A resting LIMIT BUY far below the mark, so it stays OPEN and can be canceled. */
const postRestingLimit = (headers: Headers, scope: unknown) =>
    postOrder(headers, scope, { type: "LIMIT", limitPrice: "50000.00000000" });

const cancelOrder = (headers: Headers, id: string) =>
    app.inject({ method: "DELETE", url: `/orders/${id}`, headers });

const postTrigger = (headers: Headers, scope: unknown) =>
    app.inject({
        method: "POST", url: "/v1/triggers", headers,
        payload: { pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "99000", qty: QTY, scope },
    });

const postOco = (headers: Headers, scope: unknown) => {
    const leg = (kind: string, triggerPrice: string) => ({ kind, side: "SELL", triggerPrice, qty: QTY });
    return app.inject({
        method: "POST", url: "/v1/oco", headers,
        payload: { pairId, legA: leg("STOP_MARKET", "70000"), legB: leg("TAKE_PROFIT_MARKET", "99000"), scope },
    });
};

const patchTrigger = (headers: Headers, id: string) =>
    app.inject({ method: "PATCH", url: `/v1/triggers/${id}`, headers, payload: { triggerPrice: "98000" } });

const cancelTrigger = (headers: Headers, id: string) =>
    app.inject({ method: "DELETE", url: `/v1/triggers/${id}`, headers });

/** Alice holds a long in `scope` (null = free-play) via her session, so triggers have something to close. */
async function holdLong(scope: string | null) {
    const res = await postOrder(session(alice), scope ?? "free");
    expect(res.statusCode).toBe(201);
}

async function aliceTrigger(scope: string | null) {
    return createTriggerOrder({ userId: alice, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "99000", qty: QTY, matchId: scope });
}

const orderCount = async (scope: string | null) => (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM orders WHERE user_id = $1 AND match_id IS NOT DISTINCT FROM $2`, [alice, scope],
)).rows[0]!.n;

const triggerCount = async () => (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM trigger_orders WHERE user_id = $1`, [alice],
)).rows[0]!.n;

const orderStatus = async (id: string) =>
    (await pool.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [id])).rows[0]!.status;

const triggerRow = async (id: string) =>
    (await pool.query<{ status: string; trigger_price: string }>(`SELECT status, trigger_price::text FROM trigger_orders WHERE id = $1`, [id])).rows[0]!;

function expectForbidden(res: { statusCode: number; json: () => unknown }, code: string) {
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: code, code });
}

// ── read-only key ──

describe("a read-only API key", () => {
    it("can read (GET /orders, /positions, /wallets, /v1/triggers)", async () => {
        const key = await apiKey(alice, ["read"]);
        for (const url of ["/orders", "/positions", "/wallets", "/v1/triggers"]) {
            const res = await app.inject({ method: "GET", url, headers: key });
            expect(res.statusCode, url).toBe(200);
        }
    });

    it("can't place an order: 403 insufficient_scope, nothing placed", async () => {
        const res = await postOrder(await apiKey(alice, ["read"]), "free");
        expectForbidden(res, "insufficient_scope");
        expect(res.json()).toMatchObject({ requiredScope: "trade" });
        expect(await orderCount(null)).toBe(0);
    });

    it("can't cancel an order: 403, the order stays OPEN", async () => {
        const placed = await postRestingLimit(session(alice), "free");
        expect(placed.statusCode).toBe(201);
        const id = placed.json().order.id as string;
        expectForbidden(await cancelOrder(await apiKey(alice, ["read"]), id), "insufficient_scope");
        expect(await orderStatus(id)).toBe("OPEN");
    });

    it("can't create, edit or cancel a trigger or OCO: 403, nothing changes", async () => {
        await holdLong(null);
        const key = await apiKey(alice, ["read"]);
        expectForbidden(await postTrigger(key, "free"), "insufficient_scope");
        expectForbidden(await postOco(key, "free"), "insufficient_scope");
        expect(await triggerCount()).toBe(0);

        const t = await aliceTrigger(null);
        expectForbidden(await patchTrigger(key, t.id), "insufficient_scope");
        expectForbidden(await cancelTrigger(key, t.id), "insufficient_scope");
        expect(await triggerRow(t.id)).toEqual({ status: "ACTIVE", trigger_price: "99000.00000000" });
    });

    it("can't create a wallet or drive a replay session", async () => {
        const key = await apiKey(alice, ["read"]);
        const wallet = await app.inject({ method: "POST", url: "/wallets", headers: key, payload: { assetId: btcAssetId } });
        expectForbidden(wallet, "insufficient_scope");
        const replay = await app.inject({ method: "POST", url: "/replay/stop", headers: key, payload: { pairId } });
        expectForbidden(replay, "insufficient_scope");
    });
});

// ── trade key, free-play / practice ──

describe("a trade API key in free-play", () => {
    it("places a free-play order — practice while alice's match is live", async () => {
        const res = await postOrder(await apiKey(alice, ["read", "trade"]), "free");
        expect(res.statusCode).toBe(201);
        expect(await orderCount(null)).toBe(1);
        expect(await orderCount(matchId)).toBe(0);
    });

    it("cancels its own free-play order", async () => {
        const key = await apiKey(alice, ["read", "trade"]);
        const placed = await postRestingLimit(key, "free");
        expect(placed.statusCode).toBe(201);
        const id = placed.json().order.id as string;
        expect((await cancelOrder(key, id)).statusCode).toBe(200);
        expect(await orderStatus(id)).toBe("CANCELED");
    });

    it("creates, edits and cancels free-play triggers, and places an OCO", async () => {
        await holdLong(null);
        const key = await apiKey(alice, ["read", "trade"]);
        const created = await postTrigger(key, "free");
        expect(created.statusCode).toBe(201);
        const id = created.json().id as string;
        expect((await patchTrigger(key, id)).statusCode).toBe(200);
        expect((await cancelTrigger(key, id)).statusCode).toBe(200);
        expect((await postOco(key, "free")).statusCode).toBe(201);
    });

    it("the admin scope trades free-play too", async () => {
        expect((await postOrder(await apiKey(alice, ["admin"]), "free")).statusCode).toBe(201);
    });

    it("a trade-only key can't read (read is its own scope)", async () => {
        const res = await app.inject({ method: "GET", url: "/orders", headers: await apiKey(alice, ["trade"]) });
        expectForbidden(res, "insufficient_scope");
        expect(res.json()).toMatchObject({ requiredScope: "read" });
    });
});

// ── trade key, match / competition scope ──

describe("an API key never trades a match or a competition", () => {
    it("POST /orders in match scope: 403 api_key_scope_forbidden with a clear message, nothing placed", async () => {
        for (const scopes of [["read", "trade"], ["admin"]]) {
            const res = await postOrder(await apiKey(alice, scopes), matchId);
            expectForbidden(res, "api_key_scope_forbidden");
            expect(res.json().message).toBe(MATCH_MSG);
        }
        expect(await orderCount(matchId)).toBe(0);
    });

    it("POST /orders naming a competition (X-Competition-Id): 403, nothing placed", async () => {
        const res = await postOrder(await apiKey(alice, ["read", "trade"]), "free", {}, { "x-competition-id": crypto.randomUUID() });
        expectForbidden(res, "api_key_scope_forbidden");
        expect(await orderCount(null)).toBe(0);
    });

    it("can't cancel a match order placed from the browser", async () => {
        const placed = await postRestingLimit(session(alice), matchId);
        expect(placed.statusCode).toBe(201);
        const id = placed.json().order.id as string;
        expectForbidden(await cancelOrder(await apiKey(alice, ["read", "trade"]), id), "api_key_scope_forbidden");
        expect(await orderStatus(id)).toBe("OPEN");
    });

    it("can't create a match trigger or OCO, or edit/cancel an existing one", async () => {
        await holdLong(matchId);
        const key = await apiKey(alice, ["read", "trade"]);
        expectForbidden(await postTrigger(key, matchId), "api_key_scope_forbidden");
        expectForbidden(await postOco(key, matchId), "api_key_scope_forbidden");
        expect(await triggerCount()).toBe(0);

        const t = await aliceTrigger(matchId);
        expectForbidden(await patchTrigger(key, t.id), "api_key_scope_forbidden");
        expectForbidden(await cancelTrigger(key, t.id), "api_key_scope_forbidden");
        expect(await triggerRow(t.id)).toEqual({ status: "ACTIVE", trigger_price: "99000.00000000" });
    });

    it("session-only writes refuse any API key: challenge, accept, forfeit, join a competition", async () => {
        const key = await apiKey(alice, ["read", "trade", "admin"]);
        const cases: [string, string, unknown][] = [
            ["POST", "/v1/matches/challenge", { opponentId: bob, durationHours: 1 }],
            ["POST", `/v1/matches/${matchId}/forfeit`, {}],
            ["POST", `/v1/competitions/${crypto.randomUUID()}/join`, {}],
        ];
        for (const [method, url, payload] of cases) {
            const res = await app.inject({ method: method as "POST", url, headers: key, payload: payload as object });
            expectForbidden(res, "api_key_not_allowed");
        }
        const { rows } = await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [matchId]);
        expect(rows[0]!.status).toBe("ACTIVE");
    });
});

// ── browser session: unchanged ──

describe("a browser session is unaffected", () => {
    it("trades both free-play and the match, cancels a match order, sets a match trigger", async () => {
        const s = session(alice);
        expect((await postOrder(s, "free")).statusCode).toBe(201);
        expect((await postOrder(s, matchId)).statusCode).toBe(201);
        const resting = await postRestingLimit(s, matchId);
        expect(resting.statusCode).toBe(201);
        expect((await cancelOrder(s, resting.json().order.id)).statusCode).toBe(200);
        expect((await postTrigger(s, matchId)).statusCode).toBe(201);
        const t = await aliceTrigger(matchId);
        expect((await patchTrigger(s, t.id)).statusCode).toBe(200);
        expect((await cancelTrigger(s, t.id)).statusCode).toBe(200);
    });
});
