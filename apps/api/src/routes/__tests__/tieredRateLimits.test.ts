import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

// Integration tests for the tiered per-route rate-limit overrides added as the
// MEDIUM follow-on to PR #35 (docs/followups.md: "Other endpoints starve the
// global rate-limit bucket under multi-tab load"). Four cold-load-critical read
// endpoints each get their own dedicated 60/min-per-IP bucket, independent of
// the global 100/min default, so a multi-tab cold-load burst on one endpoint no
// longer drains the shared budget the others depend on.
//
// Per endpoint, two tests mirror healthRateLimit.test.ts:
//   (a) a burst of 60 requests all return 200 — the dedicated bucket grants the
//       full 60/min of headroom (~6-12x the realistic cold-load worst case of
//       5 tabs * 1-2 init requests per tab ≈ 5-10 req/min), and
//   (b) the 61st request returns 429 — the per-route bucket is active. Note the
//       override (60/min) is TIGHTER than the global default (100/min): the
//       value of the override is bucket ISOLATION, not a higher ceiling. So the
//       discriminator (remove the override -> route falls back to the shared
//       global 100/min) flips test (b) to "expected 200 to be 429" at request
//       61, NOT test (a).
//
// Fresh app per test (beforeEach) so the in-memory rate-limit counter resets;
// sharing an app instance would leak a depleted counter into the next test and
// flake — e.g. /assets's burst would start with /pairs's count already spent.
//
// Unlike /health (public, no DB), three of these endpoints require auth
// (requireUser) and do real DB work. We mint a real JWT via app.jwt.sign and
// rely on the local dev DB (port 5435) being up + seeded — the same DB the rest
// of the non-integration suite uses. /status/system is public (no token).

const PER_ROUTE_LIMIT = 60; // keep in sync with the four route overrides

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

// A throwaway user id for minting a valid JWT. requireUser's JWT path only
// verifies the token (no DB lookup), and the handlers tolerate a user with no
// wallets (GET /wallets returns an empty array), so this id need not exist.
const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";

interface EndpointCase {
  name: string;
  url: string;
  auth: boolean;
}

const ENDPOINTS: EndpointCase[] = [
  { name: "/status/system", url: "/status/system", auth: false },
  { name: "/pairs", url: "/pairs", auth: true },
  { name: "/assets", url: "/assets", auth: true },
  { name: "/wallets", url: "/wallets", auth: true },
];

for (const ep of ENDPOINTS) {
  describe(`${ep.name} rate limiting (per-route override)`, () => {
    let app: FastifyInstance;
    let headers: Record<string, string>;

    beforeEach(async () => {
      app = await buildApp(buildOpts);
      await app.ready();
      headers = ep.auth
        ? { authorization: `Bearer ${app.jwt.sign({ sub: TEST_USER_ID, role: "USER" }, { expiresIn: 3600 })}` }
        : {};
    });

    afterEach(async () => {
      await app.close();
    });

    it("survives a multi-tab burst up to the limit without a 429", async () => {
      // The dedicated bucket must grant the full 60/min of cold-load headroom.
      for (let i = 0; i < PER_ROUTE_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: ep.url, headers });
        expect(res.statusCode).toBe(200);
      }
    });

    it("returns 429 once the per-route limit is exceeded (override is active)", async () => {
      // Discriminator: if the per-route config silently failed to apply, this
      // route would fall back to the global 100/min bucket and the 61st request
      // would still be 200. Exhaust the 60/min bucket, then the next must 429.
      for (let i = 0; i < PER_ROUTE_LIMIT; i++) {
        const res = await app.inject({ method: "GET", url: ep.url, headers });
        expect(res.statusCode).toBe(200);
      }
      const overflow = await app.inject({ method: "GET", url: ep.url, headers });
      expect(overflow.statusCode).toBe(429);
    });
  });
}
