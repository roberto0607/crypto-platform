import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";

// Integration tests: rate limits and the login lockout key on the REAL client
// IP behind Cloudflare → Railway edge (http/clientIp.ts), not on the shared
// proxy/edge address (QA 2026-10-11 P1).
//
// Topology simulated with app.inject():
//   remoteAddress  = Railway's edge proxy (TCP peer, 10.0.0.9)
//   X-Forwarded-For = "<visitor>, <address Railway saw>"  (trustProxyHops: 1
//                     → req.ip is that right-most entry)
//   CF-Connecting-IP = what Cloudflare says the visitor is
//
// Fresh app per test resets the in-memory limiter.

const GLOBAL_LIMIT = 200; // keep in sync with app.ts global `max`
const BURST_TIMEOUT = 30_000;

const RAILWAY_PROXY = "10.0.0.9";
const CF_EDGE = "104.16.1.1"; // inside 104.16.0.0/13
const NOT_CF = "203.0.113.7";
const VISITOR_A = "198.51.100.20";
const VISITOR_B = "198.51.100.21";

const buildOpts = {
  logger: false,
  trustProxyHops: 1,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

function viaCloudflare(visitor: string) {
  return {
    remoteAddress: RAILWAY_PROXY,
    headers: { "x-forwarded-for": `${visitor}, ${CF_EDGE}`, "cf-connecting-ip": visitor },
  };
}

function direct(from: string, spoofedCf: string) {
  return {
    remoteAddress: RAILWAY_PROXY,
    headers: { "x-forwarded-for": from, "cf-connecting-ip": spoofedCf },
  };
}

describe("rate limits key on the real client IP", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(buildOpts);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it(
    "two anonymous visitors behind the same Cloudflare edge get separate buckets",
    async () => {
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/status/system", ...viaCloudflare(VISITOR_A) });
        expect(res.statusCode).toBe(200);
      }
      const aOverflow = await app.inject({ method: "GET", url: "/status/system", ...viaCloudflare(VISITOR_A) });
      expect(aOverflow.statusCode).toBe(429);

      // Keyed on the edge (or the Railway proxy) this would already be 429.
      const b = await app.inject({ method: "GET", url: "/status/system", ...viaCloudflare(VISITOR_B) });
      expect(b.statusCode).toBe(200);
    },
    BURST_TIMEOUT,
  );

  it(
    "a spoofed CF-Connecting-IP from a non-Cloudflare source can't mint fresh buckets",
    async () => {
      // A direct hit on the Railway domain rotating the header every request
      // must still draw from ONE bucket: its own address.
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/status/system", ...direct(NOT_CF, `198.51.100.${i % 250}`) });
        expect(res.statusCode).toBe(200);
      }
      const overflow = await app.inject({ method: "GET", url: "/status/system", ...direct(NOT_CF, "192.0.2.99") });
      expect(overflow.statusCode).toBe(429);
    },
    BURST_TIMEOUT,
  );

  it(
    "two logged-in users behind the same proxy and edge don't share a bucket",
    async () => {
      const bearer = (sub: string) => ({
        authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}`,
      });
      const a = { remoteAddress: RAILWAY_PROXY, headers: { "x-forwarded-for": CF_EDGE, ...bearer("11111111-1111-1111-1111-111111111111") } };
      const b = { remoteAddress: RAILWAY_PROXY, headers: { "x-forwarded-for": CF_EDGE, ...bearer("22222222-2222-2222-2222-222222222222") } };
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/pairs", ...a });
        expect(res.statusCode).toBe(200);
      }
      expect((await app.inject({ method: "GET", url: "/pairs", ...a })).statusCode).toBe(429);
      expect((await app.inject({ method: "GET", url: "/pairs", ...b })).statusCode).toBe(200);
    },
    BURST_TIMEOUT,
  );

  it(
    "/auth/refresh has its own bucket — a depleted anonymous bucket can't starve a reload",
    async () => {
      for (let i = 0; i < GLOBAL_LIMIT + 1; i++) {
        await app.inject({ method: "GET", url: "/status/system", ...viaCloudflare(VISITOR_A) });
      }
      const refresh = await app.inject({ method: "POST", url: "/auth/refresh", ...viaCloudflare(VISITOR_A) });
      // No cookie → 401 from the handler, NOT 429 from the limiter.
      expect(refresh.statusCode).toBe(401);
    },
    BURST_TIMEOUT,
  );
});

describe("login lockout keys on the real client IP", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(buildOpts);
    await app.ready();
    // 20 failures (config maxLoginAttemptsPerIp) from VISITOR_A, spread over
    // distinct emails so the per-email lockout doesn't fire instead.
    await pool.query(
      `INSERT INTO login_attempts (email_normalized, ip_address, success)
       SELECT 'lockout-' || g || '@test.local', $1, false FROM generate_series(1, 20) g`,
      [VISITOR_A],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM login_attempts WHERE ip_address = ANY($1)`, [[VISITOR_A, VISITOR_B, CF_EDGE, RAILWAY_PROXY]]);
    await app.close();
  });

  const login = (from: ReturnType<typeof viaCloudflare>) =>
    app.inject({
      method: "POST",
      url: "/auth/login",
      ...from,
      headers: { ...from.headers, "content-type": "application/json" },
      payload: { email: "nobody@test.local", password: "wrong-password-123" },
    });

  it("blocks the visitor who failed, not everyone behind the same edge", async () => {
    const a = await login(viaCloudflare(VISITOR_A));
    expect(a.statusCode).toBe(429);
    expect(a.json().error.code).toBe("LOGIN_BLOCKED");

    const b = await login(viaCloudflare(VISITOR_B));
    expect(b.statusCode).toBe(401);
  });
});
