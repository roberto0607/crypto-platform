import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, registerAndLogin, getPool } from "./helpers";

let app: FastifyInstance;

beforeAll(async () => {
  app = await getTestApp();
});

afterAll(async () => {
  await closeTestApp();
});

describe("POST /auth/login", () => {
  it("returns 401 for wrong password", async () => {
    const email = `wrong-pw-${Date.now()}@test.com`;
    const password = "CorrectPass1";

    // Register first
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password },
    });

    // Login with wrong password
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "WrongPassword1" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: "invalid_credentials" });
  });

  it("returns 401 for non-existent user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `nobody-${Date.now()}@test.com`, password: "Whatever1234" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: "invalid_credentials" });
  });
});

describe("GET /auth/me — protected route", () => {
  it("returns 401 with missing Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with invalid JWT token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer invalid.token.here" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with valid token", async () => {
    const { accessToken, userId } = await registerAndLogin(app, "me-test");

    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe(userId);
  });
});

describe("POST /auth/refresh", () => {
  it("returns 401 when no refresh cookie is sent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns 401 with an invalid refresh cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: "bogus-token-value" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns new access token with valid refresh cookie", async () => {
    const { refreshCookieValue } = await registerAndLogin(app, "refresh-test");

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: refreshCookieValue },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.accessToken).toBeDefined();
  });
});

describe("POST /auth/logout", () => {
  it("revokes the refresh token so subsequent refresh fails", async () => {
    const { refreshCookieValue } = await registerAndLogin(app, "logout-test");

    // Logout
    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { refresh_token: refreshCookieValue },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json()).toEqual({ ok: true });

    // Try to refresh with the now-revoked token
    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: refreshCookieValue },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it("returns 200 even without a cookie (idempotent)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
