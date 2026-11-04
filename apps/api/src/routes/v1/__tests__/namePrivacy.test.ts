/**
 * Nothing shown to other players may come from the email address, and a
 * leaderboard row shown as "Anonymous" must say nothing about who it is. The
 * leaderboard endpoint is public, so this holds for logged-out callers too.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser } from "../../../testing/fixtures";
import {
    createMatch,
    getActiveMatchForUser,
    getMatchById,
    getMatchHistory,
    listActiveMatches,
} from "../../../competitions/matchService";

const buildOpts = {
    logger: false,
    disableKrakenFeed: true,
    disableTriggerEngine: true,
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
    disableOrchestrator: true,
    disableRateLimit: true,
} as const;

function auth(app: FastifyInstance, sub: string) {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
}

describe("name privacy", () => {
    let app: FastifyInstance;

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
    });

    describe("competition leaderboard", () => {
        let competitionId: string;
        const users: { id: string }[] = [];

        const board = (headers?: Record<string, string>) =>
            app.inject({
                method: "GET",
                url: `/v1/competitions/${competitionId}/leaderboard`,
                ...(headers ? { headers } : {}),
            });

        beforeEach(async () => {
            users.length = 0;
            const { rows } = await pool.query<{ id: string }>(
                `INSERT INTO competitions (name, start_at, end_at) VALUES ('c', now(), now() + interval '1 day') RETURNING id`,
            );
            competitionId = rows[0]!.id;
            for (let rank = 1; rank <= 12; rank++) {
                const user = await createTestUser(pool, { email: `hidden.person${rank}@test.com` });
                users.push(user);
                await pool.query(
                    `INSERT INTO competition_leaderboard (competition_id, user_id, rank, equity, return_pct)
                     VALUES ($1, $2, $3, 1000, 1)`,
                    [competitionId, user.id, rank],
                );
            }
        });

        it("names the top 10, and never from the email", async () => {
            const { data } = (await board()).json();
            for (const row of data.slice(0, 10)) {
                expect(row.user_id).toBeTruthy();
                expect(row.display_name).toMatch(/^trader_/);
            }
            expect(JSON.stringify(data)).not.toContain("hidden.person");
        });

        it("hides name and id on ranks past 10 for a logged-out caller, keeping the stats", async () => {
            const res = await board();
            const { data } = res.json();
            for (const row of data.slice(10)) {
                expect(row.user_id).toBeNull();
                expect(row.display_name).toBeNull();
                expect(row.rank).toBeGreaterThan(10);
                expect(row.return_pct).toBeDefined();
            }
            expect(res.body).not.toContain(users[10]!.id);
            expect(res.body).not.toContain(users[11]!.id);
        });

        it("hides them from another logged-in user too", async () => {
            const res = await board(auth(app, users[0]!.id));
            expect(res.body).not.toContain(users[10]!.id);
            expect(res.json().data[10].display_name).toBeNull();
        });

        it("still shows a player their own anonymous row, and only that one", async () => {
            const res = await board(auth(app, users[10]!.id));
            const { data } = res.json();
            expect(data[10].user_id).toBe(users[10]!.id);
            expect(data[10].display_name).toMatch(/^trader_/);
            expect(data[11].user_id).toBeNull();
        });

        it("ignores a forged token instead of treating it as that user", async () => {
            const forged = `${app.jwt.sign({ sub: users[10]!.id }, { expiresIn: 3600 }).slice(0, -4)}AAAA`;
            const res = await board({ authorization: `Bearer ${forged}` });
            expect(res.statusCode).toBe(200);
            expect(res.body).not.toContain(users[10]!.id);
        });

        it("the comparison endpoint names the viewer from the username, not the email", async () => {
            const res = await app.inject({
                method: "GET",
                url: `/v1/competitions/${competitionId}/comparison`,
                headers: auth(app, users[0]!.id),
            });
            expect(res.statusCode).toBe(200);
            expect(res.body).not.toContain("hidden.person");
        });
    });

    describe("matches", () => {
        it("every match read names players from the username, never the email", async () => {
            const a = await createTestUser(pool, { email: "first.lastname@test.com" });
            const b = await createTestUser(pool, { email: "other.surname@test.com" });
            const match = await createMatch(a.id, b.id, 24, []);
            await pool.query(`UPDATE matches SET status = 'ACTIVE', ends_at = now() + interval '1 day' WHERE id = $1`, [match.id]);

            const reads = [
                await getMatchById(match.id),
                await getActiveMatchForUser(a.id),
                ...(await listActiveMatches()),
                ...(await getMatchHistory(a.id, 10, 0)).matches,
            ];
            expect(reads.length).toBeGreaterThanOrEqual(3);
            for (const read of reads) {
                expect(read!.challenger_name).toMatch(/^trader_/);
                expect(read!.opponent_name).toMatch(/^trader_/);
            }
        });
    });
});
