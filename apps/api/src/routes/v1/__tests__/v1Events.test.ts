/**
 * v1Events.test.ts — SSE interest-set gating (Gate 2 step 6).
 *
 * Two layers, since a real SSE connection is long-lived and doesn't resolve
 * via app.inject():
 *   1. shouldDeliverToStream() — the actual filtering decision, extracted as
 *      a pure function and unit-tested directly (matching/non-matching
 *      pairId, empty interest set, non-pair-scoped events always passing).
 *   2. POST /v1/events/subscribe — real HTTP requests via buildApp()/inject,
 *      using the TEST-ONLY __setStreamForTest/__getStreamForTest helpers to
 *      simulate a stream having already connected (its real state is
 *      normally seeded by the GET /events handler on connect).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../app";
import { createEvent } from "../../../events/eventTypes";
import {
  shouldDeliverToStream,
  __setStreamForTest,
  __getStreamForTest,
  __clearStreamsForTest,
} from "../v1Events";

const PAIR_A = "11111111-1111-1111-1111-111111111111";
const PAIR_B = "22222222-2222-2222-2222-222222222222";

describe("shouldDeliverToStream", () => {
  it("delivers price.tick only when its pairId is in the interest set", () => {
    const event = createEvent("price.tick", { pairId: PAIR_A, symbol: "BTC/USD", bid: "1", ask: "2", last: "1.5" });
    expect(shouldDeliverToStream(event, new Set([PAIR_A]))).toBe(true);
    expect(shouldDeliverToStream(event, new Set([PAIR_B]))).toBe(false);
    expect(shouldDeliverToStream(event, new Set())).toBe(false);
  });

  it("delivers candle.closed only when its pairId is in the interest set", () => {
    const event = createEvent("candle.closed", {
      pairId: PAIR_A, timeframe: "1m", ts: Date.now(),
      open: "1", high: "1", low: "1", close: "1", volume: "1", buyVolume: "1", sellVolume: "0",
    });
    expect(shouldDeliverToStream(event, new Set([PAIR_A]))).toBe(true);
    expect(shouldDeliverToStream(event, new Set([PAIR_B]))).toBe(false);
  });

  it("always delivers non-pair-scoped events regardless of interest set", () => {
    const event = createEvent("order.updated", {
      orderId: "o1", pairId: PAIR_A, side: "BUY", type: "MARKET", status: "FILLED", qty: "1", filledQty: "1",
    });
    expect(shouldDeliverToStream(event, new Set())).toBe(true);
    expect(shouldDeliverToStream(event, new Set([PAIR_B]))).toBe(true);
  });
});

const buildOpts = {
  logger: false,
  disableKrakenFeed: true,
  disableTriggerEngine: true,
  disableJobRunner: true,
  disableOutboxWorker: true,
  disableLockSampler: true,
  disableOrchestrator: true,
} as const;

describe("POST /v1/events/subscribe", () => {
  let app: FastifyInstance;
  const userId = "33333333-3333-3333-3333-333333333333";
  const otherUserId = "44444444-4444-4444-4444-444444444444";

  beforeEach(async () => {
    app = await buildApp(buildOpts);
    await app.ready();
    __clearStreamsForTest();
  });

  afterEach(async () => {
    __clearStreamsForTest();
    await app.close();
  });

  function bearer(sub: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` };
  }

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/subscribe",
      payload: { streamId: "99999999-9999-9999-9999-999999999999", pairIds: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown streamId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/subscribe",
      headers: bearer(userId),
      payload: { streamId: "99999999-9999-9999-9999-999999999999", pairIds: [PAIR_A] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("stream_not_found");
  });

  it("404s when the streamId belongs to a different user", async () => {
    const streamId = "55555555-5555-5555-5555-555555555555";
    __setStreamForTest(streamId, { userId: otherUserId, interestSet: new Set(), handler: () => {}, spectatingMatchId: null });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events/subscribe",
      headers: bearer(userId),
      payload: { streamId, pairIds: [PAIR_A] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("replaces (not merges) the interest set for the owning user's stream", async () => {
    const streamId = "66666666-6666-6666-6666-666666666666";
    __setStreamForTest(streamId, { userId, interestSet: new Set([PAIR_B]), handler: () => {}, spectatingMatchId: null });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events/subscribe",
      headers: bearer(userId),
      payload: { streamId, pairIds: [PAIR_A] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(__getStreamForTest(streamId)?.interestSet).toEqual(new Set([PAIR_A]));
  });
});
