import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";

// Integration test for GET /v1/matches/:id/breakdown (runs against cp_test).
// Builds a COMPLETED match with match-scoped orders + fills for both
// participants, and asserts: order-level grouping, qty-weighted avg fill
// price, 403 for non-participants, 403 match_not_ended pre-terminal, and
// 404 for a nonexistent match.

const buildOpts = {
    logger: false,
    disableKrakenFeed: true,
    disableTriggerEngine: true,
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
    disableOrchestrator: true,
} as const;

function auth(app: FastifyInstance, sub: string) {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
}

async function seedFilledOrder(
    pairId: string,
    matchId: string,
    userId: string,
    side: "BUY" | "SELL",
    fills: { qty: string; price: string }[],
) {
    const qty = fills.reduce((s, f) => s + parseFloat(f.qty), 0).toFixed(8);
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO orders (user_id, pair_id, match_id, side, type, qty, qty_filled, status)
         VALUES ($1, $2, $3, $4, 'MARKET', $5, $5, 'FILLED')
         RETURNING id`,
        [userId, pairId, matchId, side, qty],
    );
    const orderId = rows[0]!.id;

    for (const f of fills) {
        const quoteAmount = (parseFloat(f.qty) * parseFloat(f.price)).toFixed(8);
        await pool.query(
            `INSERT INTO trades (pair_id, ${side === "BUY" ? "buy_order_id" : "sell_order_id"}, price, qty, quote_amount, is_system_fill)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [pairId, orderId, f.price, f.qty, quoteAmount],
        );
    }
    return orderId;
}

describe("GET /v1/matches/:id/breakdown", () => {
    let app: FastifyInstance;
    let challengerId: string;
    let opponentId: string;
    let outsiderId: string;
    let pairId: string;

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp(buildOpts);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await resetTestData();

        const challenger = await createTestUser(pool, { email: "chal@test.com" });
        const opponent = await createTestUser(pool, { email: "opp@test.com" });
        const outsider = await createTestUser(pool, { email: "out@test.com" });
        challengerId = challenger.id;
        opponentId = opponent.id;
        outsiderId = outsider.id;

        const { pair } = await createTestAssetAndPair(pool);
        pairId = pair.id;
    });

    async function seedMatch(status: "ACTIVE" | "COMPLETED" | "FORFEITED") {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, status, duration_hours, starting_capital)
             VALUES ($1, $2, $3, 24, 50000)
             RETURNING id`,
            [challengerId, opponentId, status],
        );
        return rows[0]!.id;
    }

    it("returns 200 with order-level grouping and qty-weighted avg fill price", async () => {
        const matchId = await seedMatch("COMPLETED");

        // Challenger: two-fill entry (weighted avg 50500), single-fill exit.
        await seedFilledOrder(pairId, matchId, challengerId, "BUY", [
            { qty: "0.02", price: "50000" },
            { qty: "0.02", price: "51000" },
        ]);
        await seedFilledOrder(pairId, matchId, challengerId, "SELL", [
            { qty: "0.04", price: "52000" },
        ]);
        // Opponent: single fill.
        await seedFilledOrder(pairId, matchId, opponentId, "SELL", [
            { qty: "0.02", price: "50000" },
        ]);

        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/breakdown`,
            headers: auth(app, challengerId),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.match.id).toBe(matchId);
        expect(body.match.challenger.id).toBe(challengerId);
        expect(body.match.opponent.id).toBe(opponentId);

        expect(body.challengerOrders).toHaveLength(2);
        const entry = body.challengerOrders.find((o: any) => o.side === "BUY");
        const exit = body.challengerOrders.find((o: any) => o.side === "SELL");
        expect(parseFloat(entry.avgFillPrice)).toBeCloseTo(50500, 2);
        expect(parseFloat(exit.avgFillPrice)).toBeCloseTo(52000, 2);

        expect(body.opponentOrders).toHaveLength(1);
        expect(parseFloat(body.opponentOrders[0].avgFillPrice)).toBeCloseTo(50000, 2);
    });

    it("is visible to the opponent too (both participants, not just the challenger)", async () => {
        const matchId = await seedMatch("FORFEITED");
        await seedFilledOrder(pairId, matchId, challengerId, "BUY", [{ qty: "0.01", price: "50000" }]);

        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/breakdown`,
            headers: auth(app, opponentId),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().challengerOrders).toHaveLength(1);
    });

    it("403 for a non-participant", async () => {
        const matchId = await seedMatch("COMPLETED");
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/breakdown`,
            headers: auth(app, outsiderId),
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("forbidden");
    });

    it("401 without auth", async () => {
        const matchId = await seedMatch("COMPLETED");
        const res = await app.inject({ method: "GET", url: `/v1/matches/${matchId}/breakdown` });
        expect(res.statusCode).toBe(401);
    });

    it("403 match_not_ended while the match is still ACTIVE", async () => {
        const matchId = await seedMatch("ACTIVE");
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/breakdown`,
            headers: auth(app, challengerId),
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("match_not_ended");
    });

    it("404 for a nonexistent match", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/00000000-0000-0000-0000-000000000000/breakdown`,
            headers: auth(app, challengerId),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe("match_not_found");
    });
});
