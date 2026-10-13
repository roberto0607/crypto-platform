/**
 * triggerPatch.test.ts — PATCH /v1/triggers/:id edits a trigger in place over
 * HTTP (schema + auth + error envelope). The repo-level semantics (OCO link
 * kept, trailing re-derive) are covered in src/triggers/__tests__.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";
import { allowSymbolForTest } from "../src/market/marketSymbols";
import { createTriggerOrder } from "../src/triggers/triggerRepo";
import { seedReferenceBook, clearReferenceBooks } from "../src/testing/referenceBook";

let app: FastifyInstance;
let token: string;
let userId: string;
let otherToken: string;
let otherUserId: string;
const matchIds: string[] = [];
let pairId: string;
let assetIds: string[] = [];

const uid = Math.random().toString(36).slice(2, 7).toUpperCase();

beforeAll(async () => {
    app = await getTestApp();
    const pool = getPool();
    const me = await registerAndLogin(app, "trigger-patch");
    token = me.accessToken;
    userId = me.userId;
    const other = await registerAndLogin(app, "trigger-patch-other");
    otherToken = other.accessToken;
    otherUserId = other.userId;

    const { rows: [base] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8) RETURNING id`, [`TP${uid}`],
    );
    const { rows: [quote] } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 2) RETURNING id`, [`TQ${uid}`],
    );
    assetIds = [base!.id, quote!.id];
    const { rows: [pair] } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price)
         VALUES ($1, $2, $3, true, '100.00000000') RETURNING id`,
        [base!.id, quote!.id, allowSymbolForTest(`TP${uid}/USD`)],
    );
    pairId = pair!.id;
});

afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM trigger_orders WHERE pair_id = $1`, [pairId]);
    await pool.query(`DELETE FROM matches WHERE id = ANY($1)`, [matchIds]);
    await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [pairId]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [assetIds]);
    await closeTestApp();
});

const patch = (id: string, body: unknown, bearer = token) =>
    app.inject({ method: "PATCH", url: `/v1/triggers/${id}`, headers: { authorization: `Bearer ${bearer}` }, payload: body as object });

describe("PATCH /v1/triggers/:id", () => {
    it("changes the TP price and keeps the OCO group", async () => {
        const oco = randomUUID();
        const tp = await createTriggerOrder({ userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "110", qty: "1", ocoGroupId: oco, matchId: null });

        const res = await patch(tp.id, { triggerPrice: "115" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ id: tp.id, oco_group_id: oco, trigger_price: "115.00000000", status: "ACTIVE" });
    });

    it("400s on an invalid body: both fields, neither, zero", async () => {
        const tp = await createTriggerOrder({ userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "110", qty: "1", matchId: null });
        for (const body of [{ triggerPrice: "1", trailingOffset: "1" }, {}, { triggerPrice: "0" }]) {
            const res = await patch(tp.id, body);
            expect(res.statusCode).toBe(400);
        }
    });

    it("can't change qty: unknown fields are stripped (Fastify removeAdditional), not applied", async () => {
        const tp = await createTriggerOrder({ userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "110", qty: "1", matchId: null });
        const res = await patch(tp.id, { triggerPrice: "112", qty: "5" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ trigger_price: "112.00000000", qty: "1.00000000" });
    });

    it("404s for another user's trigger and 400s for a canceled one", async () => {
        const tp = await createTriggerOrder({ userId, pairId, kind: "STOP_MARKET", side: "SELL", triggerPrice: "90", qty: "1", matchId: null });
        expect((await patch(tp.id, { triggerPrice: "95" }, otherToken)).statusCode).toBe(404);

        await getPool().query(`UPDATE trigger_orders SET status = 'CANCELED' WHERE id = $1`, [tp.id]);
        const res = await patch(tp.id, { triggerPrice: "95" });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("trigger_not_editable");
    });
});

describe("trigger scope (match_id) over HTTP", () => {
    const post = (url: string, body: object) =>
        app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: body });
    const leg = (kind: string, triggerPrice: string) => ({ kind, side: "SELL", triggerPrice, qty: "1" });

    it("is fixed at creation: free-play → null, in a match → that match (single and both OCO legs)", async () => {
        const free = await post("/v1/triggers", { pairId, ...leg("STOP_MARKET", "90") });
        expect(free.statusCode).toBe(201);
        expect(free.json().match_id).toBeNull();

        const { rows: [m] } = await getPool().query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '50000', 'ACTIVE', now(), now() + interval '24 hours') RETURNING id`,
            [userId, otherUserId],
        );
        matchIds.push(m!.id);

        const single = await post("/v1/triggers", { pairId, ...leg("STOP_MARKET", "90") });
        expect(single.json().match_id).toBe(m!.id);

        const oco = await post("/v1/oco", { pairId, legA: leg("STOP_MARKET", "90"), legB: leg("TAKE_PROFIT_MARKET", "110") });
        expect(oco.statusCode).toBe(201);
        expect(oco.json().legA.match_id).toBe(m!.id);
        expect(oco.json().legB.match_id).toBe(m!.id);

        await getPool().query(`UPDATE matches SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [m!.id]);
    });

    it("PATCH can't change match_id (stripped, not applied)", async () => {
        const tp = await createTriggerOrder({ userId, pairId, kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "110", qty: "1", matchId: null });
        const res = await patch(tp.id, { triggerPrice: "111", matchId: randomUUID(), match_id: randomUUID() });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ trigger_price: "111.00000000", match_id: null });
    });
});

// QA F6 (2026-10-11): a trailing offset is a USD price distance, so the
// server accepts 0 < offset < the live price, the same rule as the order panel.
describe("trailing-stop offset validation (pair at 100)", () => {
    const post = (url: string, body: object) =>
        app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: body });
    const trailing = (trailingOffset: string) =>
        ({ kind: "TRAILING_STOP_MARKET", side: "SELL", triggerPrice: "95", qty: "1", trailingOffset });

    beforeAll(() => seedReferenceBook(pairId, "100", "100"));
    afterAll(() => clearReferenceBooks());

    it("POST /v1/triggers: 400 for an offset of 0 or >= price, 201 inside it", async () => {
        for (const offset of ["0", "100", "150"]) {
            const res = await post("/v1/triggers", { pairId, ...trailing(offset) });
            expect(res.statusCode, `offset ${offset}`).toBe(400);
            expect(res.json().code).toBe("invalid_input");
        }
        expect((await post("/v1/triggers", { pairId, ...trailing("5") })).statusCode).toBe(201);
    });

    it("POST /v1/oco: a trailing leg with an offset >= price is rejected, and neither leg is created", async () => {
        const { rows: [before] } = await getPool().query<{ n: number }>(
            `SELECT count(*)::int AS n FROM trigger_orders WHERE pair_id = $1`, [pairId]);
        const res = await post("/v1/oco", {
            pairId,
            legA: { kind: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "110", qty: "1" },
            legB: trailing("100"),
        });
        expect(res.statusCode).toBe(400);
        const { rows: [after] } = await getPool().query<{ n: number }>(
            `SELECT count(*)::int AS n FROM trigger_orders WHERE pair_id = $1`, [pairId]);
        expect(after!.n).toBe(before!.n);
    });

    it("PATCH: 400 for an offset >= price, and the trigger is unchanged; 200 inside it", async () => {
        const tsl = await createTriggerOrder({ userId, pairId, kind: "TRAILING_STOP_MARKET", side: "SELL", triggerPrice: "95", qty: "1", trailingOffset: "5", trailingHighWaterMark: "100", matchId: null });

        const bad = await patch(tsl.id, { trailingOffset: "100" });
        expect(bad.statusCode).toBe(400);
        const { rows: [row] } = await getPool().query<{ trailing_offset: string }>(
            `SELECT trailing_offset::text FROM trigger_orders WHERE id = $1`, [tsl.id]);
        expect(row!.trailing_offset).toBe("5.00000000");

        const ok = await patch(tsl.id, { trailingOffset: "10" });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ trailing_offset: "10.00000000", trigger_price: "90.00000000" });
    });

    it("503 stale_price_source with no live price", async () => {
        clearReferenceBooks();
        try {
            const res = await post("/v1/triggers", { pairId, ...trailing("5") });
            expect(res.statusCode).toBe(503);
        } finally {
            seedReferenceBook(pairId, "100", "100");
        }
    });
});
