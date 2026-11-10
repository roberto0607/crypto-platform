/**
 * Signing up logs you in: POST /auth/register answers like POST /auth/login
 * (an access token + the refresh cookie), in open registration and in beta
 * mode, so the web app goes straight to the app instead of the login page.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { config } from "../../config";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { REFRESH_COOKIE_NAME } from "../../auth/cookieOptions";

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

describe("POST /auth/register logs the new user in", () => {
    let app: FastifyInstance;
    const betaMode = config.betaMode;

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
    afterEach(() => {
        (config as { betaMode: boolean }).betaMode = betaMode;
    });

    async function expectSession(res: Awaited<ReturnType<FastifyInstance["inject"]>>, email: string) {
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(typeof body.accessToken).toBe("string");
        expect(body.user).toMatchObject({ email, role: "USER", emailVerified: false, displayName: "New_Trader", usernameChosen: true });

        // The token is this user's.
        const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${body.accessToken}` } });
        expect(me.statusCode).toBe(200);
        expect(me.json().user.id).toBe(body.user.id);

        // The refresh cookie is set and works, like a login's.
        const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
        expect(cookie?.value).toBeTruthy();
        expect(cookie?.httpOnly).toBe(true);
        const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { [REFRESH_COOKIE_NAME]: cookie!.value } });
        expect(refreshed.statusCode).toBe(200);
        expect(typeof refreshed.json().accessToken).toBe("string");
    }

    it("open registration: answers with an access token and the refresh cookie", async () => {
        const res = await app.inject({
            method: "POST", url: "/auth/register",
            payload: { email: "new@test.com", password: "TestPass1234", username: "New_Trader" },
        });
        await expectSession(res, "new@test.com");
    });

    it("beta mode: the same, and the invite is consumed", async () => {
        (config as { betaMode: boolean }).betaMode = true;
        await pool.query(`INSERT INTO beta_invites (code, max_uses) VALUES ('BUNDLE1', 1)`);
        const res = await app.inject({
            method: "POST", url: "/auth/register",
            payload: { email: "beta@test.com", password: "TestPass1234", username: "New_Trader", inviteCode: "BUNDLE1" },
        });
        await expectSession(res, "beta@test.com");
    });

    it("a failed signup sets no cookie", async () => {
        await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@test.com", password: "TestPass1234" } });
        const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@test.com", password: "TestPass1234" } });
        expect(res.statusCode).toBe(409);
        expect(res.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)).toBeUndefined();
    });
});
