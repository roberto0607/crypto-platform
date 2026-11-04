import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { config } from "../../../config";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestAssetAndPair, createTestUser } from "../../../testing/fixtures";
import { subscribe, unsubscribe, type EventHandler } from "../../../events/eventBus";
import type { AppEvent } from "../../../events/eventTypes";

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

async function player(name: string) {
    const user = await createTestUser(pool, { email: `${name}@realmail.test` });
    await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [name, user.id]);
    return user;
}

/** Everything delivered to one user while `run` executes. */
async function eventsFor(userId: string, run: () => Promise<unknown>): Promise<AppEvent[]> {
    const events: AppEvent[] = [];
    const handler: EventHandler = (e: AppEvent) => { events.push(e); };
    subscribe(userId, handler);
    try {
        await run();
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
        unsubscribe(handler);
    }
    return events;
}

describe("challenging a player", () => {
    let app: FastifyInstance;
    let pairId: string;
    let alice: { id: string };
    let bob: { id: string };

    const challenge = (from: string, opponentId: string) =>
        app.inject({
            method: "POST",
            url: "/v1/matches/challenge",
            headers: auth(app, from),
            payload: { opponentId, durationHours: 24, allowedPairIds: [pairId] },
        });
    const cancel = (as: string) =>
        app.inject({ method: "POST", url: "/v1/matches/active/cancel", headers: auth(app, as) });
    const matchCount = async () =>
        Number((await pool.query<{ count: string }>(`SELECT count(*) FROM matches`)).rows[0]!.count);
    const pastChallenges = (from: string, to: string, count: number, age: string) =>
        pool.query(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, created_at)
             SELECT $1, $2, 24, 100000, 'CANCELLED', now() - $3::interval FROM generate_series(1, $4)`,
            [from, to, age, count],
        );

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
        pairId = (await createTestAssetAndPair(pool)).pair.id;
        alice = await player("alice_t");
        bob = await player("bob_t");
    });

    it("works end to end from a search result: found, challenged, seen, accepted", async () => {
        const search = await app.inject({
            method: "GET", url: "/v1/users/search?q=bob", headers: auth(app, alice.id),
        });
        const found = search.json().users[0];

        const sent = await challenge(alice.id, found.id);
        expect(sent.statusCode).toBe(201);

        const seen = await app.inject({ method: "GET", url: "/v1/matches/active", headers: auth(app, bob.id) });
        expect(seen.json().match).toMatchObject({ status: "PENDING", challenger_name: "alice_t" });

        const accepted = await app.inject({
            method: "POST", url: `/v1/matches/${sent.json().match.id}/accept`, headers: auth(app, bob.id),
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json().match.status).toBe("ACTIVE");
    });

    describe("who can be challenged", () => {
        it("rejects yourself with self_challenge", async () => {
            const res = await challenge(alice.id, alice.id);
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe("self_challenge");
            expect(res.json().message).toMatch(/yourself/i);
            expect(await matchCount()).toBe(0);
        });

        it("answers 404 player_not_found for an unknown id, not a 500", async () => {
            const res = await challenge(alice.id, "99999999-9999-4999-8999-999999999999");
            expect(res.statusCode).toBe(404);
            expect(res.json().code).toBe("player_not_found");
        });

        it("answers 400, not a 500, for an id that isn't one", async () => {
            const res = await challenge(alice.id, "not-a-uuid");
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe("invalid_input");
        });

        it("rejects both bots and any @system.local user", async () => {
            await pool.query(
                `INSERT INTO users (id, email, email_normalized, password_hash) VALUES
                   ($1, 'a@elsewhere.test', 'a@elsewhere.test', 'x'),
                   ($2, 'b@elsewhere.test', 'b@elsewhere.test', 'x')`,
                [config.botUserId, config.riskAgentBotUserId],
            );
            const { rows } = await pool.query<{ id: string }>(
                `INSERT INTO users (email, email_normalized, password_hash)
                 VALUES ('x@system.local', 'x@system.local', 'x') RETURNING id`,
            );
            for (const id of [config.botUserId, config.riskAgentBotUserId, rows[0]!.id]) {
                const res = await challenge(alice.id, id);
                expect(res.statusCode).toBe(400);
                expect(res.json().code).toBe("player_not_challengeable");
            }
            expect(await matchCount()).toBe(0);
        });
    });

    describe("10 challenges an hour", () => {
        it("allows the 10th and refuses the 11th with a clear message", async () => {
            await pastChallenges(alice.id, bob.id, 9, "10 minutes");
            expect((await challenge(alice.id, bob.id)).statusCode).toBe(201);
            await cancel(alice.id);

            const res = await challenge(alice.id, bob.id);
            expect(res.statusCode).toBe(429);
            expect(res.json().code).toBe("challenge_limit_reached");
            expect(res.json().message).toMatch(/10 challenges/);
        });

        it("can't be dodged by withdrawing: cancelled challenges still count", async () => {
            await pastChallenges(alice.id, bob.id, 10, "1 minute");
            expect((await challenge(alice.id, bob.id)).statusCode).toBe(429);
        });

        it("forgets challenges older than an hour", async () => {
            await pastChallenges(alice.id, bob.id, 10, "61 minutes");
            expect((await challenge(alice.id, bob.id)).statusCode).toBe(201);
        });

        it("is per challenger", async () => {
            await pastChallenges(alice.id, bob.id, 10, "1 minute");
            expect((await challenge(bob.id, alice.id)).statusCode).toBe(201);
        });
    });

    describe("notifying the opponent", () => {
        it("stores a bell notification naming the challenger and pushes it with the challenge", async () => {
            const events = await eventsFor(bob.id, () => challenge(alice.id, bob.id));
            const types = events.map((e) => e.type);
            expect(types).toContain("challenge.received");
            expect(types).toContain("notification.created");

            const { rows } = await pool.query<{ kind: string; title: string }>(
                `SELECT kind, title FROM notifications WHERE user_id = $1`,
                [bob.id],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]!.kind).toBe("CHALLENGE_RECEIVED");
            expect(rows[0]!.title).toContain("alice_t");
        });

        it("tells nobody when the challenge is refused", async () => {
            await challenge(alice.id, alice.id);
            const { rows } = await pool.query(`SELECT 1 FROM notifications`);
            expect(rows).toHaveLength(0);
        });
    });

    describe("decline and withdraw", () => {
        it("DECLINE: the opponent cancels, and the challenger hears who declined", async () => {
            const { id } = (await challenge(alice.id, bob.id)).json().match;
            const events = await eventsFor(alice.id, async () => {
                expect((await cancel(bob.id)).statusCode).toBe(200);
            });
            const closed = events.find((e) => (e.type as string) === "challenge.closed");
            expect(closed?.data).toMatchObject({ matchId: id, reason: "declined", byName: "bob_t" });
            const { rows } = await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [id]);
            expect(rows[0]!.status).toBe("CANCELLED");
        });

        it("WITHDRAW: the challenger cancels, and the opponent hears it", async () => {
            const { id } = (await challenge(alice.id, bob.id)).json().match;
            const events = await eventsFor(bob.id, async () => {
                expect((await cancel(alice.id)).statusCode).toBe(200);
            });
            const closed = events.find((e) => (e.type as string) === "challenge.closed");
            expect(closed?.data).toMatchObject({ matchId: id, reason: "withdrawn", byName: "alice_t" });
        });

        it("frees both players to play again", async () => {
            await challenge(alice.id, bob.id);
            await cancel(bob.id);
            expect((await challenge(bob.id, alice.id)).statusCode).toBe(201);
        });

        it("announces nothing when an ACTIVE match is cancelled", async () => {
            const { id } = (await challenge(alice.id, bob.id)).json().match;
            await app.inject({ method: "POST", url: `/v1/matches/${id}/accept`, headers: auth(app, bob.id) });
            const events = await eventsFor(alice.id, () => cancel(bob.id));
            expect(events.some((e) => (e.type as string) === "challenge.closed")).toBe(false);
        });
    });

    describe("GET /v1/players/:username", () => {
        const get = (name: string, as = alice.id) =>
            app.inject({ method: "GET", url: `/v1/players/${name}`, headers: auth(app, as) });

        it("requires login", async () => {
            const res = await app.inject({ method: "GET", url: "/v1/players/bob_t" });
            expect(res.statusCode).toBe(401);
        });

        it("returns public fields only, matching the name in any case", async () => {
            await pool.query(`UPDATE users SET elo_rating = 900, win_count = 2, loss_count = 1 WHERE id = $1`, [bob.id]);
            const res = await get("BOB_T");
            expect(res.statusCode).toBe(200);
            expect(res.json().player).toEqual({
                id: bob.id, username: "bob_t", tier: "ROOKIE", elo: 900, wins: 2, losses: 1,
            });
            expect(res.body).not.toContain("realmail");
        });

        it("answers player_not_found for an unknown or impossible name", async () => {
            for (const name of ["nobody_here", "a", "bad%20name"]) {
                const res = await get(name);
                expect(res.statusCode).toBe(404);
                expect(res.json().code).toBe("player_not_found");
            }
        });

        it("treats underscore literally", async () => {
            expect((await get("bobxt")).statusCode).toBe(404);
        });

        it("hides system accounts", async () => {
            await pool.query(
                `INSERT INTO users (email, email_normalized, password_hash, display_name)
                 VALUES ('x@system.local', 'x@system.local', 'x', 'market_maker')`,
            );
            expect((await get("market_maker")).statusCode).toBe(404);
        });

        it("finds yourself, so your own invite link can say so", async () => {
            expect((await get("alice_t")).json().player.id).toBe(alice.id);
        });
    });
});
