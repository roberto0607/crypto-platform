/**
 * triggerPlacement.test.ts: a TP/SL only goes on an open position it closes,
 * on the right side of the mark.
 *
 * Regression for the 2026-11 prod match: reducing a 1x long with a SHORT market
 * order that had "stop loss 76,000" filled in created a BUY stop at 76,000. The
 * long's card showed it as its stop, above the price. Real match, real wallets,
 * the real HTTP routes.
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
import { createMatch, acceptMatch, completeMatch } from "../../competitions/matchService";
import { createTriggerOrder } from "../triggerRepo";
import { fireTrigger } from "../triggerEngine";

const MARK = "70000";
const QTY = "0.01000000";

let app: FastifyInstance;
let pairId: string;
let alice: string;
let matchId: string;

const auth = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: alice, role: "USER" }, { expiresIn: 3600 })}` });

function order(side: "BUY" | "SELL", scope: string, qty = QTY, extra: object = {}) {
    return app.inject({
        method: "POST", url: "/orders",
        headers: { ...auth(), "idempotency-key": crypto.randomUUID() },
        payload: { pairId, side, type: "MARKET", qty, scope, ...extra },
    });
}

const leg = (kind: string, side: string, triggerPrice: string, extra: object = {}) => ({ kind, side, triggerPrice, qty: QTY, ...extra });
const postTrigger = (body: object, scope = matchId) =>
    app.inject({ method: "POST", url: "/v1/triggers", headers: auth(), payload: { pairId, scope, ...body } });
const postOco = (legA: object, legB: object, scope = matchId) =>
    app.inject({ method: "POST", url: "/v1/oco", headers: auth(), payload: { pairId, scope, legA, legB } });
const patchTrigger = (id: string, triggerPrice: string) =>
    app.inject({ method: "PATCH", url: `/v1/triggers/${id}`, headers: auth(), payload: { triggerPrice } });
const activeTriggers = async () => (await pool.query(
    `SELECT id FROM trigger_orders WHERE user_id = $1 AND status = 'ACTIVE'`, [alice],
)).rows;

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
    const bob = (await createTestUser(pool)).id;
    for (const u of [alice, bob]) {
        await createTestWallets(pool, u, assets.btcAsset.id, assets.usdAsset.id, "0.00000000", "100000.00000000");
    }
    const match = await createMatch(alice, bob, 24, [pairId]);
    await acceptMatch(match.id, bob);
    matchId = match.id;
});

describe("a trigger must close an open position", () => {
    it("the prod case: long reduced by a SHORT order, its BUY stop at 76,000 is refused", async () => {
        expect((await order("BUY", matchId)).statusCode).toBe(201);
        expect((await order("SELL", matchId, "0.00400000", { reduceOnly: true })).statusCode).toBe(201);

        const res = await postTrigger(leg("STOP_MARKET", "BUY", "76000"));

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("trigger_not_reducing");
        expect(res.json().message).toMatch(/open position/i);
        expect(await activeTriggers()).toEqual([]);
    });

    it("a full close: nothing left, so any trigger is refused", async () => {
        await order("BUY", matchId);
        await order("SELL", matchId, QTY, { reduceOnly: true });
        for (const side of ["BUY", "SELL"]) {
            const stop = side === "SELL" ? "65000" : "76000";
            expect((await postTrigger(leg("STOP_MARKET", side, stop))).json().code).toBe("trigger_not_reducing");
        }
    });

    it("no position at all: refused", async () => {
        const res = await postTrigger(leg("TAKE_PROFIT_MARKET", "SELL", "76000"));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("trigger_not_reducing");
    });

    it("a trailing stop follows the same rule", async () => {
        await order("BUY", matchId);
        const wrong = leg("TRAILING_STOP_MARKET", "BUY", "70500", { trailingOffset: "500.00000000" });
        expect((await postTrigger(wrong)).json().code).toBe("trigger_not_reducing");
    });

    it("OCO: one bad leg refuses both", async () => {
        await order("BUY", matchId);
        const res = await postOco(leg("STOP_MARKET", "BUY", "76000"), leg("TAKE_PROFIT_MARKET", "SELL", "76000"));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("trigger_not_reducing");
        expect(await activeTriggers()).toEqual([]);
    });

    it("the position is looked up in the scope named: a free-play long doesn't cover the match", async () => {
        await order("BUY", "free");
        expect((await postTrigger(leg("STOP_MARKET", "SELL", "65000"))).json().code).toBe("trigger_not_reducing");
        expect((await postTrigger(leg("STOP_MARKET", "SELL", "65000"), "free")).statusCode).toBe(201);
    });

    it("the remaining long can still be protected after a reduce", async () => {
        await order("BUY", matchId);
        await order("SELL", matchId, "0.00400000", { reduceOnly: true });
        expect((await postTrigger(leg("STOP_MARKET", "SELL", "65000"))).statusCode).toBe(201);
    });

    it("a flip: the new short takes its BUY triggers", async () => {
        await order("BUY", matchId);
        await order("SELL", matchId, "0.02000000");
        const res = await postOco(leg("STOP_MARKET", "BUY", "76000"), leg("TAKE_PROFIT_MARKET", "BUY", "65000"));
        expect(res.statusCode).toBe(201);
    });
});

describe("a trigger sits on the right side of the mark", () => {
    const cases: [string, "BUY" | "SELL", string, string, string, string][] = [
        ["long SL", "BUY", "SELL", "STOP_MARKET", "69000", "71000"],
        ["long TP", "BUY", "SELL", "TAKE_PROFIT_MARKET", "71000", "69000"],
        ["short SL", "SELL", "BUY", "STOP_MARKET", "71000", "69000"],
        ["short TP", "SELL", "BUY", "TAKE_PROFIT_MARKET", "69000", "71000"],
    ];

    it.each(cases)("%s", async (_name, open, side, kind, good, bad) => {
        await order(open as "BUY" | "SELL", matchId);
        const res = await postTrigger(leg(kind, side, bad));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("trigger_wrong_side_of_mark");
        expect(res.json().details).toMatchObject({ mark: "70000.00000000" });
        expect((await postTrigger(leg(kind, side, good))).statusCode).toBe(201);
    });

    it("at the mark exactly: refused, it would fire at once", async () => {
        await order("BUY", matchId);
        expect((await postTrigger(leg("STOP_MARKET", "SELL", MARK))).json().code).toBe("trigger_wrong_side_of_mark");
    });

    it("OCO: a price on the wrong side refuses both legs", async () => {
        await order("BUY", matchId);
        const res = await postOco(leg("STOP_MARKET", "SELL", "71000"), leg("TAKE_PROFIT_MARKET", "SELL", "76000"));
        expect(res.json().code).toBe("trigger_wrong_side_of_mark");
        expect(await activeTriggers()).toEqual([]);
    });

    it("PATCH can't move a stop past the mark, and the trigger stays as it was", async () => {
        await order("BUY", matchId);
        const { id } = (await postTrigger(leg("STOP_MARKET", "SELL", "65000"))).json();

        const res = await patchTrigger(id, "76000");

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("trigger_wrong_side_of_mark");
        const { rows } = await pool.query(`SELECT trigger_price::text FROM trigger_orders WHERE id = $1`, [id]);
        expect(rows[0].trigger_price).toBe("65000.00000000");
        expect((await patchTrigger(id, "66000")).statusCode).toBe(200);
    });

    it("no live price: 503, never judged against a stale one", async () => {
        await order("BUY", matchId);
        clearReferenceBooks();
        const res = await postTrigger(leg("STOP_MARKET", "SELL", "65000"));
        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe("stale_price_source");
    });
});

describe("a wrong-side trigger already in the database (made before this check)", () => {
    const legacyBuyStop = () => createTriggerOrder({
        userId: alice, pairId, kind: "STOP_MARKET", side: "BUY", triggerPrice: "76000", qty: "0.00264300", matchId,
    });
    const state = async (id: string) => (await pool.query(
        `SELECT status, fail_reason, derived_order_id FROM trigger_orders WHERE id = $1`, [id],
    )).rows[0];

    it("match end cancels it and places no order", async () => {
        await order("BUY", matchId);
        const stop = await legacyBuyStop();
        await completeMatch(matchId);
        expect(await state(stop.id)).toEqual({ status: "CANCELED", fail_reason: "match_ended", derived_order_id: null });
    });

    it("price reaching it before the end cancels it (no_position) and places no order", async () => {
        await order("BUY", matchId);
        const stop = await legacyBuyStop();
        await fireTrigger(stop, { last: "76000", ts: new Date().toISOString() } as never);
        expect(await state(stop.id)).toEqual({ status: "CANCELED", fail_reason: "no_position", derived_order_id: null });
        const { rows } = await pool.query(`SELECT base_qty::text FROM positions WHERE user_id = $1 AND match_id = $2`, [alice, matchId]);
        expect(rows[0].base_qty).toBe(QTY);
    });
});
