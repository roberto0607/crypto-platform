/**
 * positionTriggers.test.ts: TP/SL belong to the position, not to an order.
 *
 * Regression for the 2026-11 prod case: a 0.00661 long, then ADD TO LONG
 * 0.01322 with TP/SL. The position was 0.01983 and the card read as if it was
 * protected, but both triggers held 0.01322: a stop would have left 0.00661
 * open. Real match, real wallets, the real HTTP routes and fills.
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
import { createMatch, acceptMatch } from "../../competitions/matchService";
import { createTriggerOrder } from "../triggerRepo";
import { fireTrigger } from "../triggerEngine";

const MARK = "75000";
const TP = "77000";
const SL = "73000";

let app: FastifyInstance;
let pairId: string;
let alice: string;
let bob: string;
let matchId: string;
const saved = { ...config.leverage };

const auth = (sub = alice) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

async function order(side: "BUY" | "SELL", qty: string, scope = matchId, extra: object = {}, uid = alice) {
    const res = await app.inject({
        method: "POST", url: "/orders",
        headers: { ...auth(uid), "idempotency-key": crypto.randomUUID() },
        payload: { pairId, side, type: "MARKET", qty, scope, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
}

const tp = (side = "SELL", price = TP) => ({ kind: "TAKE_PROFIT_MARKET", side, triggerPrice: price });
const sl = (side = "SELL", price = SL) => ({ kind: "STOP_MARKET", side, triggerPrice: price });
const postTrigger = (body: object, scope = matchId) =>
    app.inject({ method: "POST", url: "/v1/triggers", headers: auth(), payload: { pairId, scope, ...body } });
const postOco = (legA: object, legB: object, scope = matchId) =>
    app.inject({ method: "POST", url: "/v1/oco", headers: auth(), payload: { pairId, scope, legA, legB } });

/** The active triggers in a scope, as [kind, qty], TP before SL. */
async function active(scope: string | null = matchId) {
    const { rows } = await pool.query<{ kind: string; qty: string }>(
        `SELECT kind, qty::text FROM trigger_orders
         WHERE user_id = $1 AND status = 'ACTIVE' AND match_id IS NOT DISTINCT FROM $2::uuid
         ORDER BY kind DESC`,
        [alice, scope],
    );
    return rows.map((r) => [r.kind, r.qty]);
}

const positionQty = async (scope: string | null = matchId) => (await pool.query<{ base_qty: string }>(
    `SELECT base_qty::text FROM positions WHERE user_id = $1 AND pair_id = $2 AND match_id IS NOT DISTINCT FROM $3::uuid`,
    [alice, pairId, scope],
)).rows[0]?.base_qty;

const both = (qty: string) => [["TAKE_PROFIT_MARKET", qty], ["STOP_MARKET", qty]];

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
    seedReferenceBook(pairId, MARK, MARK);
    resetMarketDataPairIdCache();
    alice = (await createTestUser(pool)).id;
    bob = (await createTestUser(pool)).id;
    for (const u of [alice, bob]) {
        await createTestWallets(pool, u, assets.btcAsset.id, assets.usdAsset.id, "0.00000000", "100000.00000000");
    }
    const match = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(match.id, bob);
    matchId = match.id;
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe("size: always the whole position", () => {
    it("the prod case: 0.00661 long, ADD 0.01322 with TP/SL, both cover 0.01983", async () => {
        await order("BUY", "0.00661000");
        await order("BUY", "0.01322000");
        // What the panel sends after an add.
        const res = await postOco({ ...tp(), qty: "0.01322000" }, { ...sl(), qty: "0.01322000" });
        expect(res.statusCode).toBe(201);
        expect(await active()).toEqual(both("0.01983000"));
    });

    it("no qty needed; one sent is ignored", async () => {
        await order("BUY", "0.01000000");
        expect((await postTrigger(sl())).json().qty).toBe("0.01000000");
        expect((await postTrigger({ ...tp(), qty: "5.00000000" })).json().qty).toBe("0.01000000");
    });

    it("grows on an add, shrinks on a reduce", async () => {
        await order("BUY", "0.01000000");
        await postOco(tp(), sl());
        await order("BUY", "0.00500000");
        expect(await active()).toEqual(both("0.01500000"));
        await order("SELL", "0.00400000", matchId, { reduceOnly: true });
        expect(await active()).toEqual(both("0.01100000"));
    });

    it("a short's BUY triggers follow it too", async () => {
        await order("SELL", "0.01000000");
        await postOco(tp("BUY", "73000"), sl("BUY", "77000"));
        await order("SELL", "0.00500000");
        expect(await active()).toEqual(both("0.01500000"));
    });

    it("an ISOLATED position follows it too", async () => {
        Object.assign(config.leverage, { enabled: true, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [] });
        await order("BUY", "0.01000000", "free", { leverage: 2 });
        await postOco(tp(), sl(), "free");
        await order("BUY", "0.01000000", "free", { leverage: 2 });
        expect(await active(null)).toEqual(both("0.02000000"));
    });

    it("a fill as maker resizes too: a resting limit that reduces", async () => {
        await order("BUY", "0.01000000", "free");
        await postOco(tp(), sl(), "free");
        const rest = await app.inject({
            method: "POST", url: "/orders", headers: { ...auth(), "idempotency-key": crypto.randomUUID() },
            payload: { pairId, side: "SELL", type: "LIMIT", qty: "0.00300000", limitPrice: MARK, scope: "free" },
        });
        expect(rest.statusCode, rest.body).toBe(201);
        await order("BUY", "0.00300000", "free", {}, bob);
        expect(await active(null)).toEqual(both("0.00700000"));
    });

    it("firing closes the whole position, even from a trigger stored with less", async () => {
        await order("BUY", "0.01983000");
        const legacy = await createTriggerOrder({
            userId: alice, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: SL, qty: "0.01322000", matchId,
        });
        await fireTrigger(legacy, { last: SL, ts: new Date().toISOString() } as never);
        expect(await positionQty()).toBe("0.00000000");
    });
});

describe("count: at most one TP, one SL, one trailing stop", () => {
    const status = async (id: string) => (await pool.query(
        `SELECT status, fail_reason FROM trigger_orders WHERE id = $1`, [id],
    )).rows[0];

    it("setting a stop again replaces it", async () => {
        await order("BUY", "0.01000000");
        const first = (await postTrigger(sl())).json();
        const second = await postTrigger(sl("SELL", "72000"));
        expect(second.statusCode).toBe(201);
        expect(await status(first.id)).toEqual({ status: "CANCELED", fail_reason: "replaced" });
        expect(await active()).toEqual([["STOP_MARKET", "0.01000000"]]);
    });

    it("an add with new TP/SL replaces both, it doesn't stack", async () => {
        await order("BUY", "0.01000000");
        await postOco(tp(), sl());
        await order("BUY", "0.01000000");
        await postOco(tp("SELL", "78000"), sl("SELL", "72000"));
        expect(await active()).toEqual(both("0.02000000"));
    });

    it("a new SL leaves the TP alone", async () => {
        await order("BUY", "0.01000000");
        await postOco(tp(), sl());
        await postTrigger(sl("SELL", "72000"));
        expect(await active()).toEqual(both("0.01000000"));
    });

    it("a trailing stop has its own slot", async () => {
        await order("BUY", "0.01000000");
        const trailing = { kind: "TRAILING_STOP_MARKET", side: "SELL", triggerPrice: "74000", trailingOffset: "1000.00000000" };
        await postTrigger(sl());
        await postTrigger(trailing);
        await postTrigger(trailing);
        expect(await active()).toEqual([["TRAILING_STOP_MARKET", "0.01000000"], ["STOP_MARKET", "0.01000000"]]);
    });

    it("an OCO of two stops is refused, nothing changes", async () => {
        await order("BUY", "0.01000000");
        await postTrigger(sl());
        const res = await postOco(sl("SELL", "72000"), sl("SELL", "71000"));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("invalid_input");
        expect(await active()).toEqual([["STOP_MARKET", "0.01000000"]]);
    });

    it("a refused replacement leaves the old one active", async () => {
        await order("BUY", "0.01000000");
        await postTrigger(sl());
        expect((await postTrigger(sl("SELL", "76000"))).statusCode).toBe(400);
        expect(await active()).toEqual([["STOP_MARKET", "0.01000000"]]);
    });

    it("free-play works the same, and each scope keeps its own", async () => {
        await order("BUY", "0.01000000", "free");
        await order("BUY", "0.02000000");
        await postOco(tp(), sl(), "free");
        await postOco(tp(), sl());
        await postTrigger(sl("SELL", "72000"), "free");
        expect(await active(null)).toEqual(both("0.01000000"));
        expect(await active()).toEqual(both("0.02000000"));
    });
});

describe("close", () => {
    it("closing cancels them", async () => {
        await order("BUY", "0.01000000");
        await postOco(tp(), sl());
        await order("SELL", "0.01000000", matchId, { reduceOnly: true });
        expect(await active()).toEqual([]);
    });

    it("a flip cancels them; the new short starts with none", async () => {
        await order("BUY", "0.01000000");
        await postOco(tp(), sl());
        await order("SELL", "0.03000000");
        expect(await active()).toEqual([]);
        await postOco(tp("BUY", "73000"), sl("BUY", "77000"));
        expect(await active()).toEqual(both("0.02000000"));
    });
});
