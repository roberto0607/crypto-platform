/**
 * The UI explains every unrated or scaled ELO change in plain words ("Repeat
 * opponent — 3rd match in 24h", "Opponent didn't trade enough", "50% — 2nd
 * match vs this opponent today"). match_elo_results keeps what that needs
 * beyond the reason code: the match's number for the pair in the 24h window,
 * and which player traded enough. GET /v1/matches/:id/result and match
 * history return them. Written only with ELO_INTEGRITY_ENABLED on.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";

vi.mock("../../notifications/notificationService", () => ({
    notifyTriggerFired: vi.fn().mockResolvedValue(undefined),
    notifyCompetitionEnded: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser } from "../../testing/fixtures";
import { resolveMatchElo } from "../eloService";
import type { MatchActivity } from "../eloIntegrity";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms);
const QUALIFIED: MatchActivity = { fills: 2, notional: 10_000 };
const THIN: MatchActivity = { fills: 1, notional: 100 };

let n = 0;
const player = async () => (await createTestUser(pool, { email: `why${++n}@test.local` })).id;

async function finished(winner: string, loser: string, at: Date, forfeitEarly = false): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status,
                              winner_id, forfeit_user_id, started_at, completed_at)
         VALUES ($1, $2, 0.25, 50000, $3, $1, $4, $5, $6) RETURNING id`,
        [winner, loser, forfeitEarly ? "FORFEITED" : "COMPLETED", forfeitEarly ? loser : null,
            new Date(at.getTime() - (forfeitEarly ? MIN : 15 * MIN)), at],
    );
    return rows[0]!.id;
}

async function resolve(matchId: string, activity: Map<string, MatchActivity>) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await resolveMatchElo(matchId, client, { activity });
        await client.query("COMMIT");
    } finally {
        client.release();
    }
}

const detail = async (id: string) => (await pool.query(
    `SELECT winner_unrated_reason, pair_match_number, winner_qualified, loser_qualified
       FROM match_elo_results WHERE match_id = $1`, [id])).rows[0];

let app: FastifyInstance;

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
    config.eloIntegrityEnabled = true;
});
afterEach(() => {
    config.eloIntegrityEnabled = false;
});

describe("match_elo_results keeps why", () => {
    it("the pair's 1st, 2nd and 3rd match in 24h", async () => {
        const [a, b] = [await player(), await player()];
        const ids: string[] = [];
        for (const h of [3, 2, 1]) {
            const id = await finished(a, b, ago(h * HOUR));
            await resolve(id, new Map([[a, QUALIFIED], [b, QUALIFIED]]));
            ids.push(id);
        }
        expect(await detail(ids[0]!)).toEqual({ winner_unrated_reason: null, pair_match_number: 1, winner_qualified: true, loser_qualified: true });
        expect((await detail(ids[1]!)).pair_match_number).toBe(2);
        expect(await detail(ids[2]!)).toMatchObject({ winner_unrated_reason: "REPEAT_OPPONENT", pair_match_number: 3 });
    });

    it("which player didn't trade enough", async () => {
        const [a, b, c, d] = [await player(), await player(), await player(), await player()];
        const loserThin = await finished(a, b, ago(HOUR));
        await resolve(loserThin, new Map([[a, QUALIFIED], [b, THIN]]));
        expect(await detail(loserThin)).toMatchObject({ winner_unrated_reason: "NOT_QUALIFIED", winner_qualified: true, loser_qualified: false });
        const winnerThin = await finished(c, d, ago(HOUR));
        await resolve(winnerThin, new Map([[d, QUALIFIED]]));
        expect(await detail(winnerThin)).toMatchObject({ winner_unrated_reason: "NOT_QUALIFIED", winner_qualified: false, loser_qualified: true });
    });

    it("flag off: nothing new is written", async () => {
        config.eloIntegrityEnabled = false;
        const [a, b] = [await player(), await player()];
        const id = await finished(a, b, ago(HOUR));
        await resolve(id, new Map([[a, QUALIFIED], [b, QUALIFIED]]));
        expect(await detail(id)).toEqual({ winner_unrated_reason: null, pair_match_number: null, winner_qualified: null, loser_qualified: null });
    });
});

describe("the API returns it", () => {
    it("GET /v1/matches/:id/result and GET /v1/matches/history", async () => {
        const [a, b] = [await player(), await player()];
        const id = await finished(a, b, ago(HOUR));
        await resolve(id, new Map([[a, QUALIFIED], [b, THIN]]));
        const headers = { authorization: `Bearer ${app.jwt.sign({ sub: b, role: "USER" }, { expiresIn: 3600 })}` };

        const result = (await app.inject({ method: "GET", url: `/v1/matches/${id}/result`, headers })).json().result;
        expect(result).toMatchObject({ winner_unrated_reason: "NOT_QUALIFIED", pair_match_number: 1, winner_qualified: true, loser_qualified: false });

        const history = await app.inject({ method: "GET", url: `/v1/matches/history`, headers });
        expect(history.statusCode, history.body).toBe(200);
        const [row] = history.json().matches;
        expect(row).toMatchObject({ winner_unrated_reason: "NOT_QUALIFIED", pair_match_number: 1, winner_qualified: true, loser_qualified: false });
    });
});
