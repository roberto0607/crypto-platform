import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

// Integration test for the /health per-route rate-limit override
// (healthRoutes.ts). /health gets its own 120/min bucket, independent of the
// global 100/min-per-IP limit, so multi-tab cold-load bursts don't 429 it.
//
// We build the real app (rate limiting ON — `disableRateLimit` left false) and
// disable every background service so no DB/Redis/feed connection is needed;
// the basic /health route itself does no DB work. A fresh app per test gives
// the in-memory rate-limit store a clean counter.

const HEALTH_LIMIT = 120; // keep in sync with healthRoutes.ts

async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp({
    logger: false,
    disableKrakenFeed: true,
    disableTriggerEngine: true,
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableLockSampler: true,
    disableOrchestrator: true,
  });
}

describe("/health rate limiting", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 under normal load (single request)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "api" });
  });

  it("survives a multi-tab burst up to the limit without a 429", async () => {
    // The whole point of the override: the global default is 100/min, so a burst
    // past 100 would 429 /health if the per-route bucket weren't active. All 120
    // must succeed.
    for (let i = 0; i < HEALTH_LIMIT; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("returns 429 once the per-route limit is exceeded (override is active)", async () => {
    // Discriminator: if the per-route config silently failed to apply, /health
    // would either 429 at 101 (global limit still in force) or never 429 at all.
    // Exhaust the bucket, then the next request must be 429.
    for (let i = 0; i < HEALTH_LIMIT; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
    const overflow = await app.inject({ method: "GET", url: "/health" });
    expect(overflow.statusCode).toBe(429);
  });
});
