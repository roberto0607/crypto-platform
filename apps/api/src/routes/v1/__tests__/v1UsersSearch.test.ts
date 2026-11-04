import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { pool } from "../../../db/pool";
import { config } from "../../../config";
import { ensureMigrations, resetTestData } from "../../../testing/resetDb";
import { createTestUser } from "../../../testing/fixtures";

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

async function named(name: string, email = `${name.toLowerCase()}@private-mail.test`) {
    const user = await createTestUser(pool, { email });
    await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [name, user.id]);
    return user;
}

describe("GET /v1/users/search", () => {
    let app: FastifyInstance;
    let me: { id: string };

    async function search(q: string, as = me.id) {
        return app.inject({
            method: "GET",
            url: `/v1/users/search?q=${encodeURIComponent(q)}`,
            headers: auth(app, as),
        });
    }

    beforeAll(async () => {
        await ensureMigrations();
        app = await buildApp({ ...buildOpts, disableRateLimit: true });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await resetTestData();
        me = await named("searcher");
    });

    it("requires auth", async () => {
        const res = await app.inject({ method: "GET", url: "/v1/users/search?q=ab" });
        expect(res.statusCode).toBe(401);
    });

    it("returns public fields only, with no email anywhere in the response", async () => {
        const target = await named("Satoshi", "very.private@secret-mail.test");
        await pool.query(`UPDATE users SET elo_rating = 1234, win_count = 7, loss_count = 3 WHERE id = $1`, [target.id]);
        await pool.query(`INSERT INTO user_tiers (user_id, tier) VALUES ($1, 'PRO')`, [target.id]);

        const res = await search("sat");
        expect(res.statusCode).toBe(200);
        const { users } = res.json();
        expect(users).toEqual([
            { id: target.id, username: "Satoshi", tier: "PRO", elo: 1234, wins: 7, losses: 3 },
        ]);
        expect(users[0]).not.toHaveProperty("email");
        expect(res.body).not.toContain("secret-mail");
        expect(res.body).not.toContain("very.private");
        expect(res.body).not.toContain("role");
    });

    it("defaults the tier for a user with no tier row", async () => {
        await named("Rookie_One");
        const { users } = (await search("rookie")).json();
        expect(users[0].tier).toBe("ROOKIE");
    });

    it("matches a prefix, case-insensitively", async () => {
        const alice = await named("AliceTrader");
        await named("Malice"); // contains the term, doesn't start with it
        for (const q of ["ali", "ALI", "aLiCe", "alicetrader"]) {
            const { users } = (await search(q)).json();
            expect(users.map((u: { id: string }) => u.id)).toEqual([alice.id]);
        }
    });

    it("treats underscore literally, not as a LIKE wildcard", async () => {
        const match = await named("a_ce");
        await named("alice");
        const { users } = (await search("a_")).json();
        expect(users.map((u: { id: string }) => u.id)).toEqual([match.id]);
    });

    it("excludes yourself", async () => {
        const { users } = (await search("sea")).json();
        expect(users).toEqual([]);
    });

    it("excludes both bots and every @system.local user", async () => {
        await pool.query(
            `INSERT INTO users (id, email, email_normalized, password_hash, display_name) VALUES
               ($1, 'mm@elsewhere.test', 'mm@elsewhere.test', 'x', 'bot_market'),
               ($2, 'ra@elsewhere.test', 'ra@elsewhere.test', 'x', 'bot_risk'),
               (gen_random_uuid(), 'x@system.local', 'x@system.local', 'x', 'bot_system')`,
            [config.botUserId, config.riskAgentBotUserId],
        );
        const human = await named("bot_human");
        const { users } = (await search("bot")).json();
        expect(users.map((u: { id: string }) => u.id)).toEqual([human.id]);
    });

    it("rejects fewer than 2 characters, trimmed", async () => {
        expect((await search("a")).statusCode).toBe(400);
        expect((await search(" a ")).statusCode).toBe(400);
        expect((await search("")).statusCode).toBe(400);
        expect((await app.inject({
            method: "GET", url: "/v1/users/search", headers: auth(app, me.id),
        })).statusCode).toBe(400);
    });

    it("searches on exactly 2 characters", async () => {
        await named("ab_player");
        expect((await search("ab")).json().users).toHaveLength(1);
    });

    it("returns nothing, not an error, for characters no username can contain", async () => {
        await named("alice");
        for (const q of ["al%", "%%", "a'; --", "al ice", "@private-mail"]) {
            const res = await search(q);
            expect(res.statusCode).toBe(200);
            expect(res.json().users).toEqual([]);
        }
    });

    it("never matches on email", async () => {
        await named("zzz_name", "findme@private-mail.test");
        expect((await search("findme")).json().users).toEqual([]);
    });

    it("returns at most 10 results, in name order", async () => {
        for (let i = 11; i >= 0; i--) await named(`multi_${String(i).padStart(2, "0")}`);
        const { users } = (await search("multi")).json();
        expect(users).toHaveLength(10);
        expect(users[0].username).toBe("multi_00");
        expect(users[9].username).toBe("multi_09");
    });
});

describe("GET /v1/users/search rate limit", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        await ensureMigrations();
        await resetTestData();
        app = await buildApp({ ...buildOpts, disableRateLimit: false });
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    it("limits per user at 60 a minute, without touching another user's budget", async () => {
        const a = await named("limit_a");
        const b = await named("limit_b");
        const hit = (id: string) =>
            app.inject({ method: "GET", url: "/v1/users/search?q=li", headers: auth(app, id) });

        for (let i = 0; i < 60; i++) expect((await hit(a.id)).statusCode).toBe(200);
        expect((await hit(a.id)).statusCode).toBe(429);
        expect((await hit(b.id)).statusCode).toBe(200);
    });
});
