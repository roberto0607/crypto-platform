import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser } from "../../testing/fixtures";

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

describe("choosing a username", () => {
    let app: FastifyInstance;

    const register = (payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url: "/auth/register", payload });
    const signup = (email: string, username?: string) =>
        register({ email, password: "TestPass1234", ...(username ? { username } : {}) });
    const rename = (id: string, displayName: string) =>
        app.inject({ method: "PATCH", url: "/v1/profile", headers: auth(app, id), payload: { displayName } });
    const whoAmI = async (id: string) =>
        (await app.inject({ method: "GET", url: "/auth/me", headers: auth(app, id) })).json().user;

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

    describe("POST /auth/register", () => {
        it("stores the chosen username", async () => {
            const res = await signup("a@test.com", "Chosen_One");
            expect(res.statusCode).toBe(201);
            const me = await whoAmI(res.json().user.id);
            expect(me.displayName).toBe("Chosen_One");
            expect(me.usernameChosen).toBe(true);
        });

        it("falls back to a default that reveals nothing, and asks for a choice", async () => {
            const res = await signup("revealing.person@test.com");
            expect(res.statusCode).toBe(201);
            const me = await whoAmI(res.json().user.id);
            expect(me.displayName).toMatch(/^trader_[0-9a-f]{10}$/);
            expect(me.usernameChosen).toBe(false);
        });

        it("rejects a taken username whatever its case, and creates no account", async () => {
            await signup("a@test.com", "Taken_Name");
            const res = await signup("b@test.com", "TAKEN_name");
            expect(res.statusCode).toBe(409);
            expect(res.json().error).toBe("username_taken");
            const { rows } = await pool.query(`SELECT 1 FROM users WHERE email_normalized = 'b@test.com'`);
            expect(rows).toHaveLength(0);
        });

        it("still answers email_taken for a repeated email", async () => {
            await signup("a@test.com", "first_name");
            const res = await signup("a@test.com", "second_name");
            expect(res.statusCode).toBe(409);
            expect(res.json().error).toBe("email_taken");
        });

        it("rejects a reserved username whatever its case", async () => {
            const res = await signup("a@test.com", "ADMIN");
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toBe("username_reserved");
        });

        it.each(["ab", "a".repeat(31), "has space", "bad-name!"])("rejects the invalid username %j", async (username) => {
            const res = await signup("a@test.com", username);
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toBe("invalid_input");
        });
    });

    describe("POST /auth/login", () => {
        it("returns the username, so the UI never needs the email to name someone", async () => {
            await signup("a@test.com", "Login_Name");
            const res = await app.inject({
                method: "POST",
                url: "/auth/login",
                payload: { email: "a@test.com", password: "TestPass1234" },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().user).toMatchObject({ displayName: "Login_Name", usernameChosen: true });
        });
    });

    describe("PATCH /v1/profile", () => {
        it("renames, and stops asking for a choice", async () => {
            const user = await createTestUser(pool);
            expect((await whoAmI(user.id)).usernameChosen).toBe(false);
            const res = await rename(user.id, "New_Name");
            expect(res.statusCode).toBe(200);
            const me = await whoAmI(user.id);
            expect(me.displayName).toBe("New_Name");
            expect(me.usernameChosen).toBe(true);
        });

        it("lets a user keep their default on purpose", async () => {
            const user = await createTestUser(pool);
            const current = (await whoAmI(user.id)).displayName;
            expect((await rename(user.id, current)).statusCode).toBe(200);
            expect((await whoAmI(user.id)).usernameChosen).toBe(true);
        });

        it("lets a user change only the case of their own name", async () => {
            const user = await createTestUser(pool);
            await rename(user.id, "case_name");
            expect((await rename(user.id, "Case_Name")).statusCode).toBe(200);
        });

        it("answers username_taken for a clash in any case", async () => {
            const [a, b] = [await createTestUser(pool), await createTestUser(pool)];
            await rename(a.id, "Taken_Name");
            const res = await rename(b.id, "taken_NAME");
            expect(res.statusCode).toBe(409);
            expect(res.json().error).toBe("username_taken");
        });

        it("answers username_reserved", async () => {
            const user = await createTestUser(pool);
            const res = await rename(user.id, "Support");
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toBe("username_reserved");
        });
    });
});
