import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../../testing/fixtures";

// Integration test for GET /v1/matches/:id/replay (runs against cp_test, #77).
// Builds a minimal completed match whose match_positions sum EXACTLY to the
// stored *_pnl_pct, then asserts the end-to-end oracle: each player's
// reconstructed curve final pnlPct equals the stored headline.

const buildOpts = {
    logger: false,
    disableKrakenFeed: true,
    disableTriggerEngine: true,
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
    disableOrchestrator: true,
} as const;

const FIVE_MIN = 300_000;
const HOUR = 3_600_000;
const BASE = Date.parse("2026-06-01T00:00:00Z");

function auth(app: FastifyInstance, sub: string) {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
}

describe("GET /v1/matches/:id/replay", () => {
    let app: FastifyInstance;
    let matchId: string;
    let challengerId: string;
    let opponentId: string;
    let outsiderId: string;

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

        // Stored finals: challenger +4.0% (=$2000/50000), opponent -2.0% (=-$1000).
        const { rows: matchRows } = await pool.query<{ id: string }>(
            `INSERT INTO matches
               (challenger_id, opponent_id, status, duration_hours, starting_capital,
                challenger_pnl_pct, opponent_pnl_pct, winner_id, elo_resolved,
                started_at, ends_at, completed_at)
             VALUES ($1,$2,'COMPLETED',24,50000, 4.0, -2.0, $1, true,
                     $3, $4, $5)
             RETURNING id`,
            [challengerId, opponentId,
             new Date(BASE), new Date(BASE + 24 * HOUR), new Date(BASE + HOUR)],
        );
        matchId = matchRows[0]!.id;

        // Positions: stored pnl sums exactly to the finals.
        // challenger LONG, pnl 2000 ; opponent SHORT, pnl -1000.
        const open = new Date(BASE + 10 * 60_000);
        const close = new Date(BASE + 50 * 60_000);
        await pool.query(
            `INSERT INTO match_positions
               (match_id, user_id, pair_id, side, entry_price, qty, exit_price, pnl, opened_at, closed_at)
             VALUES
               ($1,$2,$3,'LONG', 50000, 0.04, 50000, 2000, $5, $6),
               ($1,$4,$3,'SHORT',50000, 0.02, 50000, -1000, $5, $6)`,
            [matchId, challengerId, pair.id, opponentId, open, close],
        );

        // 5m candles spanning the padded window [minOpen-1h, maxClose+1h].
        const from = BASE + 10 * 60_000 - HOUR;
        const to = BASE + 50 * 60_000 + HOUR;
        const values: string[] = [];
        const params: unknown[] = [pair.id];
        let idx = 2;
        for (let ts = Math.floor(from / FIVE_MIN) * FIVE_MIN; ts <= to; ts += FIVE_MIN) {
            // close = 51000 so open positions mark to a non-zero unrealized mid-curve,
            // while the realized endpoints use the stored pnl.
            values.push(`($1,'5m',$${idx},51000,51000,51000,51000,1)`);
            params.push(new Date(ts));
            idx++;
        }
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             VALUES ${values.join(",")}`,
            params,
        );
    });

    it("returns 200 with structure and both reconstructed curves", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/replay`,
            headers: auth(app, challengerId),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.source).toBe("match_positions");
        expect(body.match.id).toBe(matchId);
        expect(body.candles["BTC/USD"].length).toBeGreaterThan(0);
        expect(body.positions).toHaveLength(2);
        expect(Object.keys(body.curves)).toEqual(
            expect.arrayContaining([challengerId, opponentId]),
        );
        // curves aligned to candle timeline, no NaN
        for (const uid of [challengerId, opponentId]) {
            const curve = body.curves[uid];
            expect(curve.length).toBeGreaterThan(0);
            expect(curve.every((p: any) => typeof p.pnlPct === "number" && !Number.isNaN(p.pnlPct))).toBe(true);
        }
    });

    it("ORACLE: each player's final curve pnlPct == stored headline", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/replay`,
            headers: auth(app, challengerId),
        });
        const body = res.json();
        const chalCurve = body.curves[challengerId];
        const oppCurve = body.curves[opponentId];
        expect(chalCurve[chalCurve.length - 1].pnlPct).toBeCloseTo(4.0, 6);
        expect(oppCurve[oppCurve.length - 1].pnlPct).toBeCloseTo(-2.0, 6);
        // and the final equity reflects realized only (positions closed)
        expect(chalCurve[chalCurve.length - 1].unrealizedPnl).toBe(0);
    });

    it("403 for a non-participant", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/replay`,
            headers: auth(app, outsiderId),
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("forbidden");
    });

    it("401 without auth", async () => {
        const res = await app.inject({ method: "GET", url: `/v1/matches/${matchId}/replay` });
        expect(res.statusCode).toBe(401);
    });

    it("422 no_replay_data when the match has no match_positions", async () => {
        await pool.query(`DELETE FROM match_positions WHERE match_id = $1`, [matchId]);
        const res = await app.inject({
            method: "GET",
            url: `/v1/matches/${matchId}/replay`,
            headers: auth(app, challengerId),
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe("no_replay_data");
    });
});
