import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

// Integration tests for per-user rate-limit keying (PR #37, app.ts keyGenerator).
//
// Replaces the per-route override approach of PR #36 (whose test,
// tieredRateLimits.test.ts, is deleted alongside this file). The global limiter
// now keys by the authenticated USER when a Bearer JWT is present
// (`user:{sub}`) and falls back to the client IP otherwise (`ip:{req.ip}`),
// with the default ceiling raised from 100 to 200/min per key.
//
// Mechanics these tests rely on:
//   - The global limiter (app.ts) uses ONE shared store across every route that
//     has no per-route override. So /status/system and /pairs draw from the same
//     bucket for a given key — depleting one depletes the other (the original
//     starvation mechanic, now keyed per-user/per-IP instead of per-IP only).
//   - /health keeps its OWN 120/min store (PR #35, healthRoutes.ts), isolated
//     from the global store — so the global change doesn't regress it.
//   - The limiter runs at onRequest; requireUser runs at preHandler. The limiter
//     fires FIRST, so a request rejected by the limiter returns 429 before
//     requireUser would have a chance to 401 a bad/missing token.
//
// app.inject() requests all originate from 127.0.0.1, so every unauthenticated
// request in a test shares one IP key. A fresh app per test (beforeEach) resets
// the in-memory counters.
//
// /pairs, /status/system, and /assets do real DB work (active-pairs / system-flag
// reads), so these tests require the local dev DB (port 5435) up — same
// dependency the rest of the integration suite has.

const GLOBAL_LIMIT = 200; // keep in sync with app.ts global `max`
const HEALTH_LIMIT = 120; // keep in sync with healthRoutes.ts override (PR #35)

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

// 200-request bursts hitting the DB sequentially exceed vitest's 5s default.
const BURST_TIMEOUT = 30_000;

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

describe("per-user rate limiting (PR #37)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(buildOpts);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // requireUser's JWT path only verifies the token (no DB lookup), so these ids
  // need not exist; the handlers tolerate a user with no wallets/pairs context.
  function bearer(sub: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
  }

  it(
    "keys authenticated traffic by user — userA's depletion does not touch userB's bucket",
    async () => {
      // THE HEADLINE TEST. userA exhausts their own 200/min bucket on /pairs...
      const a = bearer(USER_A);
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/pairs", headers: a });
        expect(res.statusCode).toBe(200);
      }
      const aOverflow = await app.inject({ method: "GET", url: "/pairs", headers: a });
      expect(aOverflow.statusCode).toBe(429);

      // ...and userB, on the SAME IP but a different `user:{sub}` key, still has
      // a full bucket. If keying were still per-IP (or the keyGenerator failed
      // to apply), userB's first request would already be 429 — that is the
      // failure signature that means this whole PR is broken.
      const b = bearer(USER_B);
      const bRes = await app.inject({ method: "GET", url: "/pairs", headers: b });
      expect(bRes.statusCode).toBe(200);
    },
    BURST_TIMEOUT,
  );

  it(
    "keys unauthenticated traffic by IP — global ceiling is 200, not 100",
    async () => {
      // No Authorization header -> `ip:{req.ip}` keying (case 5 folds in here).
      // All 200 succeed (proves the ceiling was raised from 100), the 201st 429s
      // (proves the IP fallback still enforces a limit).
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/status/system" });
        expect(res.statusCode).toBe(200);
      }
      const overflow = await app.inject({ method: "GET", url: "/status/system" });
      expect(overflow.statusCode).toBe(429);
    },
    BURST_TIMEOUT,
  );

  it(
    "falls back to IP keying for a malformed token (does not mint a fresh user bucket)",
    async () => {
      // Deplete the shared IP bucket via the public route...
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/status/system" });
        expect(res.statusCode).toBe(200);
      }
      // ...then a malformed-token request to a different global-bucket route from
      // the same IP must draw from that SAME depleted bucket -> 429. The decode
      // throws, so keyGenerator falls back to `ip:{req.ip}` rather than treating
      // "not-a-real-jwt" as a distinct user key. A 200 here would mean the bad
      // token got its own bucket; a 401 would mean requireUser ran before the
      // limiter (it must not). Either is a regression.
      const res = await app.inject({
        method: "GET",
        url: "/pairs",
        headers: { authorization: "Bearer not-a-real-jwt" },
      });
      expect(res.statusCode).toBe(429);
    },
    BURST_TIMEOUT,
  );

  it(
    "keeps /health on its own 120/min bucket (PR #35 override intact)",
    async () => {
      // Regression guard: the global change must not disturb /health's dedicated
      // store. 120 succeed, the 121st 429s — identical to PR #35's behavior.
      for (let i = 0; i < HEALTH_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
      }
      const overflow = await app.inject({ method: "GET", url: "/health" });
      expect(overflow.statusCode).toBe(429);
    },
    BURST_TIMEOUT,
  );
});
