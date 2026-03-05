/**
 * Extended auth route tests — covers edge cases not in auth.test.ts.
 *
 * These are integration tests using the real Fastify app and PostgreSQL.
 */
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

/* ════════════════════════════════════════════════════════════
   POST /auth/register
   ════════════════════════════════════════════════════════════ */

describe("POST /auth/register", () => {
  it("creates user and returns 201", async () => {
    const email = `reg-ok-${Date.now()}@test.com`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "StrongPass1" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe(email);
    expect(body.user.id).toBeDefined();
    expect(body.user.role).toBe("USER");
  });

  it("rejects duplicate email (case-insensitive)", async () => {
    const email = `dup-${Date.now()}@test.com`;
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "StrongPass1" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: email.toUpperCase(), password: "StrongPass1" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("rejects password shorter than 8 characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `short-${Date.now()}@test.com`, password: "Ab1cdef" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("rejects password longer than 72 characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `long-${Date.now()}@test.com`, password: "A".repeat(73) },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid email format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "not-an-email", password: "StrongPass1" },
    });

    expect(res.statusCode).toBe(400);
  });
});

/* ════════════════════════════════════════════════════════════
   POST /auth/login
   ════════════════════════════════════════════════════════════ */

describe("POST /auth/login", () => {
  it("returns access token and sets refresh cookie on success", async () => {
    const email = `login-ok-${Date.now()}@test.com`;
    const password = "TestPass1234";

    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password },
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.accessToken).toBeDefined();
    expect(body.user.email).toBe(email);

    const cookies = res.cookies as Array<{ name: string; value: string }>;
    const refreshCookie = cookies.find((c) => c.name === "refresh_token");
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie!.value).toBeTruthy();
  });

  it("records login attempt on failure", async () => {
    const email = `attempt-${Date.now()}@test.com`;
    const password = "TestPass1234";

    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password },
    });

    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "WrongPassword1" },
    });

    const pool = getPool();
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt FROM login_attempts WHERE email_normalized = $1 AND success = false`,
      [email.toLowerCase()],
    );
    expect(parseInt(result.rows[0].cnt, 10)).toBeGreaterThanOrEqual(1);
  });

  it("creates audit log entry on success", async () => {
    const email = `audit-${Date.now()}@test.com`;
    const password = "TestPass1234";

    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password },
    });

    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });

    const pool = getPool();
    const result = await pool.query(
      `SELECT action FROM audit_log WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].action).toBe("auth.login");
  });

  it("rejects invalid email format in login", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "bad-email", password: "TestPass1234" },
    });

    expect(res.statusCode).toBe(400);
  });
});

/* ════════════════════════════════════════════════════════════
   POST /auth/refresh — extended
   ════════════════════════════════════════════════════════════ */

describe("POST /auth/refresh — extended", () => {
  it("rotates refresh token (old token invalid, new cookie set)", async () => {
    const { refreshCookieValue } = await registerAndLogin(app, "rotate-test");

    // First refresh — should succeed
    const res1 = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: refreshCookieValue },
    });
    expect(res1.statusCode).toBe(200);

    // Extract new refresh cookie
    const cookies1 = res1.cookies as Array<{ name: string; value: string }>;
    const newCookie = cookies1.find((c) => c.name === "refresh_token");
    expect(newCookie).toBeDefined();

    // Old token should now fail (reuse detection)
    const res2 = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: refreshCookieValue },
    });
    expect(res2.statusCode).toBe(401);
    const body2 = res2.json();
    expect(body2.error).toBe("refresh_token_reuse");
  });

  it("new refresh token from rotation works", async () => {
    const { refreshCookieValue } = await registerAndLogin(app, "chain-test");

    // First rotation
    const res1 = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: refreshCookieValue },
    });
    expect(res1.statusCode).toBe(200);

    const cookies1 = res1.cookies as Array<{ name: string; value: string }>;
    const newCookieValue = cookies1.find((c) => c.name === "refresh_token")!.value;

    // Second rotation using the new token — should succeed
    const res2 = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { refresh_token: newCookieValue },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().accessToken).toBeDefined();
  });
});

/* ════════════════════════════════════════════════════════════
   POST /auth/logout — extended
   ════════════════════════════════════════════════════════════ */

describe("POST /auth/logout — extended", () => {
  it("clears refresh cookie in response", async () => {
    const { refreshCookieValue } = await registerAndLogin(app, "logout-cookie");

    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { refresh_token: refreshCookieValue },
    });

    expect(res.statusCode).toBe(200);
    const cookies = res.cookies as Array<{ name: string; value: string }>;
    const refreshCookie = cookies.find((c) => c.name === "refresh_token");
    // Cookie should be cleared (empty value or expired)
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie!.value).toBe("");
  });
});

/* ════════════════════════════════════════════════════════════
   GET /auth/me — extended
   ════════════════════════════════════════════════════════════ */

describe("GET /auth/me — extended", () => {
  it("returns current user info with valid token", async () => {
    const { accessToken, userId } = await registerAndLogin(app, "me-ext");

    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe(userId);
    expect(body.user.role).toBe("USER");
  });
});
