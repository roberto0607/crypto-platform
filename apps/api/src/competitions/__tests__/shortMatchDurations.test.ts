/**
 * 15-minute, 1-hour and 4-hour matches. Duration only sets ends_at: settlement,
 * ELO and the season board must come out the same as for a 24-hour match.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { createMatch, acceptMatch, forfeitMatch } from "../matchService";
import { matchCleanupJob } from "../../jobs/definitions/matchCleanupJob";
import { logger } from "../../observability/logContext";

let app: FastifyInstance;
let pairId: string;
let btc: string;
let usd: string;

const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

async function trader(): Promise<string> {
    const u = await createTestUser(pool);
    await pool.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [u.id, `t${u.id.slice(0, 8)}`]);
    await createTestWallets(pool, u.id, btc, usd, "0.00000000", "100000.00000000");
    return u.id;
}

const challenge = (from: string, opponentId: string, durationHours: number) => app.inject({
    method: "POST", url: "/v1/matches/challenge", headers: auth(from),
    payload: { opponentId, durationHours, allowedPairIds: [pairId] },
});

const elo = async (id: string) => (await pool.query<{ elo_rating: number }>(
    `SELECT elo_rating FROM users WHERE id = $1`, [id],
)).rows[0]!.elo_rating;

/** One full forfeit: what each player's ELO moved by. */
async function forfeitDeltas(hours: number) {
    const [a, b] = [await trader(), await trader()];
    const [ea, eb] = [await elo(a), await elo(b)];
    const m = await createMatch(a, b, hours, [pairId]);
    await acceptMatch(m.id, b);
    await forfeitMatch(m.id, a);
    return { loser: (await elo(a)) - ea, winner: (await elo(b)) - eb };
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
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btc = assets.btcAsset.id;
    usd = assets.usdAsset.id;
    resetMarketDataPairIdCache();
});

describe("the challenge accepts the new durations", () => {
    it.each([[0.25, 15], [1, 60], [4, 240], [24, 1440], [168, 10080], [672, 40320]])(
        "%s hours: ends %s minutes after accept", async (hours, minutes) => {
            const [a, b] = [await trader(), await trader()];
            const res = await challenge(a, b, hours);
            expect(res.statusCode).toBe(201);
            expect(res.json().match.duration_hours).toBe(hours);
            const accepted = await acceptMatch(res.json().match.id, b);
            const span = new Date(accepted.ends_at!).getTime() - new Date(accepted.started_at!).getTime();
            expect(span).toBe(minutes * 60_000);
        },
    );

    it.each([0, 0.5, 2, 12, 100, -1])("refuses %s hours", async (hours) => {
        const [a, b] = [await trader(), await trader()];
        expect((await challenge(a, b, hours)).statusCode).toBe(400);
    });

    it("the database refuses anything else too", async () => {
        const [a, b] = [await trader(), await trader()];
        await expect(pool.query(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital) VALUES ($1, $2, 2, 100000)`, [a, b],
        )).rejects.toThrow(/duration_hours/);
    });
});

describe("duration changes nothing else", () => {
    it("ELO: a 15-minute forfeit moves the same as a 24-hour one", async () => {
        expect(await forfeitDeltas(0.25)).toEqual(await forfeitDeltas(24));
    });

    it("a 15-minute match past ends_at is settled by the cleanup job", async () => {
        const [a, b] = [await trader(), await trader()];
        const m = await createMatch(a, b, 0.25, [pairId]);
        await acceptMatch(m.id, b);
        await pool.query(`UPDATE matches SET ends_at = now() - interval '1 second' WHERE id = $1`, [m.id]);
        await matchCleanupJob.run({ pool, logger, signal: new AbortController().signal });
        const { rows } = await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [m.id]);
        expect(rows[0]!.status).toBe("FORFEITED"); // no trades: the same mutual forfeit as any length
        const { rows: closed } = await pool.query(`SELECT 1 FROM wallets WHERE match_id = $1 AND closed_at IS NULL`, [m.id]);
        expect(closed).toEqual([]);
    });
});
