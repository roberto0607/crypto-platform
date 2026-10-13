/**
 * corsPreflight.test.ts — every HTTP method the web app sends cross-origin
 * must pass the CORS preflight.
 *
 * Regression for the 2026-10-12 prod bug: PATCH /v1/triggers/:id (TP/SL edit,
 * PR #202) failed in Safari with "Method PATCH is not allowed by
 * Access-Control-Allow-Methods". Local dev never saw it because the Vite proxy
 * is same-origin, so no preflight is sent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

const ORIGIN = "https://playtradr.com";
let app: FastifyInstance;
let savedOrigins: string | undefined;

beforeAll(async () => {
    // CORS_ORIGINS is read when the app is built — build a dedicated instance
    // with the prod web origin on the allowlist.
    savedOrigins = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = ORIGIN;
    app = await buildApp({ disableRateLimit: true, logger: false, disableKrakenFeed: true });
    await app.ready();
});

afterAll(async () => {
    await app.close();
    if (savedOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = savedOrigins;
});

const preflight = (url: string, method: string, origin = ORIGIN) =>
    app.inject({
        method: "OPTIONS",
        url,
        headers: {
            origin,
            "access-control-request-method": method,
            "access-control-request-headers": "content-type,authorization",
        },
    });

const allowedMethods = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["access-control-allow-methods"] ?? "").split(",").map((m) => m.trim());

describe("CORS preflight", () => {
    it("allows PATCH /v1/triggers/:id from the prod web origin", async () => {
        const res = await preflight("/v1/triggers/00000000-0000-0000-0000-000000000000", "PATCH");

        expect(res.statusCode).toBeGreaterThanOrEqual(200);
        expect(res.statusCode).toBeLessThan(300);
        expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
        expect(res.headers["access-control-allow-credentials"]).toBe("true");
        expect(allowedMethods(res)).toContain("PATCH");
    });

    // Every non-GET/POST method the web client uses (apps/web/src/api/endpoints).
    it.each([
        ["PATCH", "/v1/profile"],
        ["PATCH", "/v1/admin/competitions/00000000-0000-0000-0000-000000000000/cancel"],
        ["PATCH", "/admin/users/00000000-0000-0000-0000-000000000000/role"],
        ["PUT", "/admin/account-limits"],
        ["DELETE", "/v1/triggers/00000000-0000-0000-0000-000000000000"],
        ["DELETE", "/orders/00000000-0000-0000-0000-000000000000"],
        ["DELETE", "/v1/alerts/00000000-0000-0000-0000-000000000000"],
    ])("allows %s %s", async (method, url) => {
        const res = await preflight(url, method);
        expect(res.statusCode).toBeLessThan(300);
        expect(allowedMethods(res)).toContain(method);
    });

    it("does not grant an origin that isn't on the allowlist", async () => {
        const res = await preflight("/v1/triggers/00000000-0000-0000-0000-000000000000", "PATCH", "https://evil.example");
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
});
