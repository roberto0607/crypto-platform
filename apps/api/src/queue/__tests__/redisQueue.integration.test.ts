/**
 * redisQueue.integration.test.ts — INTEGRATION test (real Redis, slow).
 *
 * Why this is an integration test, not a unit test:
 *   The bug fixed in PR #26 was a *wire serialization* defect — the order
 *   queue carried `matchId` correctly in-process (in-memory queue) but
 *   corrupted it crossing Redis Streams: `undefined`/`null` was flattened to
 *   "" at enqueue and read back as null at dequeue, so every in-match order in
 *   prod was written with match_id = NULL. A mock/in-memory Redis can't catch
 *   that class of bug — only a real Redis round-trip exercises the actual
 *   XADD/XREADGROUP field serialization. So this spins up an ephemeral Redis
 *   via testcontainers. It's deliberately kept out of the default `pnpm test`
 *   suite (see vitest.config.ts exclude); run it with `pnpm test:integration`.
 *
 * Regression coverage for: https://github.com/roberto0607/crypto-platform/pull/26
 *
 * Requires Docker to be available (testcontainers spins its own container).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import { setRedis, setRedisSub, setBlockingRedisFactory, getRedis } from "../../db/redis";
import { config } from "../../config";
import type { PlaceOrderResult } from "../../trading/phase6OrderService";

// Mock the order service so the consumer's processJob calls a spy we can
// inspect, instead of touching Postgres / the real matching engine. We assert
// on the matchId argument it receives — the exact value PR #26's bug corrupted.
vi.mock("../../trading/phase6OrderService", () => ({
  placeOrderWithSnapshot: vi.fn(),
}));

// Mock prom-client metrics to avoid global-registry side effects and noise.
vi.mock("../../metrics", () => ({
  pairQueueDepth: { set: vi.fn() },
  pairQueueRejectionsTotal: { inc: vi.fn() },
  pairQueueWaitMs: { observe: vi.fn() },
  pairQueueExecMs: { observe: vi.fn() },
  pairQueueXdelFailuresTotal: { inc: vi.fn() },
}));

// Imported after the mocks (vi.mock is hoisted) so these pull in the mocked deps.
import { enqueueRedis, initRedisQueue, shutdownRedisQueue } from "../redisQueue";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";

const FAKE_RESULT: PlaceOrderResult = {
  order: { id: "fake-order" } as any,
  fills: [],
  snapshot: {} as any,
  fromIdempotencyCache: false,
};

function payload(pairId: string) {
  return { pairId, side: "BUY" as const, type: "MARKET" as const, qty: "1" };
}

// XREVRANGE returns fields as a flat [name, value, name, value, ...] array.
function fieldValue(fields: string[], name: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === name) return fields[i + 1];
  }
  return undefined;
}

// processJob calls placeOrderWithSnapshot(userId, payload, idempotencyKey,
// requestId, competitionId, matchId) — so requestId is arg index 3, matchId 5.
const ARG_REQUEST_ID = 3;
const ARG_MATCH_ID = 5;

// Poll until `pred` is truthy or `timeoutMs` elapses (then throw).
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

// Test-only queue-depth cap for the XLEN regression tests — same proof as the
// real 100, ~10x faster CI. Applied per-test via a config override + restore.
const DEPTH_TEST_CAP = 10;

let container: StartedRedisContainer;
let cmd: Redis;
let sub: Redis;

// The four serialization assertions below share one pairId for simplicity —
// each tests a single enqueue's wire format, so one consumer is all they need.
// (Concurrent multi-pair behavior, which used to deadlock on the shared
// connection before the dedicated-blocking-connection fix, has its own test at
// the bottom of this file.)
const PAIR_ID = randomUUID();

describe("redisQueue — matchId wire serialization (integration, real Redis; regression for PR #26)", () => {
  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    const url = container.getConnectionUrl();
    // Mirror initRedis() exactly: command client gets keyPrefix "cp:", the
    // subscriber connection does not (ioredis needs a dedicated sub connection).
    cmd = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true, keyPrefix: "cp:" });
    sub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
    await Promise.all([cmd.connect(), sub.connect()]);
    setRedis(cmd);
    setRedisSub(sub);
    // Each consumer creates its own blocking connection via this factory — point
    // it at the container (config.redisUrl is empty in tests). Mirrors the
    // command connection's keyPrefix so XREADGROUP's queue:<pairId> resolves.
    setBlockingRedisFactory(() =>
      new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true, keyPrefix: "cp:" }),
    );
    // Subscribe to the result channel so enqueueRedis promises can resolve.
    await initRedisQueue();
  }, 120_000);

  afterAll(async () => {
    // shutdownRedisQueue now disconnect()s each consumer's blocking connection
    // to interrupt the in-flight BLOCK, so this returns promptly (no ~5s wait).
    await shutdownRedisQueue(8_000);
    setBlockingRedisFactory(null);
    setRedis(null);
    setRedisSub(null);
    await Promise.all([cmd?.quit().catch(() => {}), sub?.quit().catch(() => {})]);
    await container?.stop();
  });

  beforeEach(() => {
    vi.mocked(placeOrderWithSnapshot).mockReset();
    vi.mocked(placeOrderWithSnapshot).mockResolvedValue(FAKE_RESULT);
  });

  // Assertion 1 — serialization of a real match UUID.
  it("serializes a match-scoped order's matchId as the literal UUID in the stream", async () => {
    const matchId = randomUUID();

    await enqueueRedis(PAIR_ID, "u1", payload(PAIR_ID), undefined, "req-1", undefined, undefined, matchId);

    const entries = (await getRedis()!.xrevrange(`queue:${PAIR_ID}`, "+", "-", "COUNT", 1)) as [string, string[]][];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const mv = fieldValue(entries[0][1], "matchId");
    expect(mv).toBe(matchId);
    expect(mv).not.toBe("");
    expect(mv).not.toBe("__free_play__");
  });

  // Assertion 2 — serialization of null (free-play) as the sentinel, never "".
  it('serializes a free-play order (null matchId) as the "__free_play__" sentinel', async () => {
    await enqueueRedis(PAIR_ID, "u1", payload(PAIR_ID), undefined, "req-2", undefined, undefined, null);

    // COUNT 1 → the latest entry, which is this test's enqueue (tests run serially).
    const entries = (await getRedis()!.xrevrange(`queue:${PAIR_ID}`, "+", "-", "COUNT", 1)) as [string, string[]][];
    expect(fieldValue(entries[0][1], "matchId")).toBe("__free_play__");
  });

  // Assertion 3 — full round-trip: dequeue passes the value through to phase6.
  it("round-trips through dequeue: phase6 receives the UUID, and null for free-play", async () => {
    const matchId = randomUUID();
    await enqueueRedis(PAIR_ID, "u3", payload(PAIR_ID), undefined, "req-3a", undefined, undefined, matchId);
    expect(placeOrderWithSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(placeOrderWithSnapshot).mock.calls[0][ARG_MATCH_ID]).toBe(matchId);

    vi.mocked(placeOrderWithSnapshot).mockClear();
    await enqueueRedis(PAIR_ID, "u3", payload(PAIR_ID), undefined, "req-3b", undefined, undefined, null);
    expect(placeOrderWithSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(placeOrderWithSnapshot).mock.calls[0][ARG_MATCH_ID]).toBeNull();
  });

  // Assertion 4 — backward-compat: a pre-fix job with matchId="" must not crash
  // and must dequeue as null (the defensive ""→null mapping).
  it('backward-compat: a pre-fix queued job with matchId="" dequeues as null, not a crash', async () => {
    const redis = getRedis()!;

    // Simulate a job enqueued by pre-fix code: matchId stored as "".
    await redis.xadd(
      `queue:${PAIR_ID}`, "*",
      "correlationId", randomUUID(),
      "instanceId", config.instanceId,
      "userId", "legacy-user",
      "pairId", PAIR_ID,
      "payload", JSON.stringify(payload(PAIR_ID)),
      "idempotencyKey", "",
      "requestId", "legacy-job",
      "competitionId", "",
      "matchId", "", // ← pre-fix empty string
      "enqueuedAt", Date.now().toString(),
    );

    // A normal enqueue on the same pair drives the consumer, which drains both
    // the legacy entry (lower stream id, processed first) and this one. Awaiting
    // it guarantees the legacy entry was processed.
    await enqueueRedis(PAIR_ID, "trigger-user", payload(PAIR_ID), undefined, "trigger-job", undefined, undefined, randomUUID());

    const legacyCall = vi
      .mocked(placeOrderWithSnapshot)
      .mock.calls.find((c) => c[ARG_REQUEST_ID] === "legacy-job");
    expect(legacyCall, "legacy job should have been processed by the consumer").toBeDefined();
    expect(legacyCall![ARG_MATCH_ID]).toBeNull();
  });

  // Concurrency regression for the dedicated-blocking-connection fix. Three
  // distinct pairs enqueued at once → three consumers, each on its OWN blocking
  // connection. Pre-fix, all consumers shared one connection, so a blocking
  // read on one pair stalled the others and this batch would serialize into
  // ~5s idle-block cycles (or deadlock/time out). Post-fix it resolves near
  // instantly. The sub-second assertion is the "fast, not just eventually"
  // proof that the architecture — not luck — fixed it.
  it("processes 3 pairs concurrently with correct matchIds, in under 1 second", async () => {
    const pairs = [randomUUID(), randomUUID(), randomUUID()];
    const matchIds = [randomUUID(), randomUUID(), randomUUID()];

    const start = Date.now();
    await Promise.all(
      pairs.map((p, i) =>
        enqueueRedis(p, `u-multi-${i}`, payload(p), undefined, `req-multi-${i}`, undefined, undefined, matchIds[i]),
      ),
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);

    // Each pair's order round-tripped through its own consumer with its own
    // matchId intact (no cross-pair mixups, no lost values).
    const calls = vi.mocked(placeOrderWithSnapshot).mock.calls;
    for (let i = 0; i < pairs.length; i++) {
      const call = calls.find((c) => c[ARG_REQUEST_ID] === `req-multi-${i}`);
      expect(call, `pair ${i} (req-multi-${i}) should have been processed`).toBeDefined();
      expect(call![ARG_MATCH_ID]).toBe(matchIds[i]);
    }
  });

  // ── Regression for the XLEN depth bug (see docs/designs/2026-05-26-xlen-queue-bug.md) ──
  // XACK alone left entries in the stream, so XLEN grew without bound and the
  // enqueue depth guard (pair_queue_overloaded) tripped permanently after
  // maxQueueDepth lifetime orders per pair — even fully drained. The fix XDELs
  // each message after XACK so XLEN tracks live depth. These live in this
  // describe (not their own) because initRedisQueue after a shutdown doesn't
  // re-arm the module-level `accepting` flag — sharing this block's already-live
  // queue keeps it true. Each test overrides config.maxQueueDepth locally.

  // THE FIX: process 2x the cap; the stream drains and the guard never trips.
  // Without the XDEL this fails at ~cap+1 (enqueue rejects; XLEN never shrinks).
  it(`processes ${2 * DEPTH_TEST_CAP} orders (2x cap) without tripping pair_queue_overloaded; stream drains to ~0`, async () => {
    const restore = config.maxQueueDepth;
    (config as { maxQueueDepth: number }).maxQueueDepth = DEPTH_TEST_CAP;
    try {
      const pairId = randomUUID();
      for (let i = 0; i < 2 * DEPTH_TEST_CAP; i++) {
        // Each await resolves only after the consumer processed -> acked -> XDEL'd.
        await enqueueRedis(pairId, `u-${i}`, payload(pairId), undefined, `req-depth-${i}`, undefined, undefined, null);
      }
      expect(placeOrderWithSnapshot).toHaveBeenCalledTimes(2 * DEPTH_TEST_CAP);

      // Fully drained: XLEN reflects live depth now, not lifetime order count.
      const xlen = await getRedis()!.xlen(`queue:${pairId}`);
      expect(xlen).toBeLessThanOrEqual(1); // ≤1 = small in-flight slack
    } finally {
      (config as { maxQueueDepth: number }).maxQueueDepth = restore;
    }
  });

  // GUARD STILL WORKS: when the consumer can't keep up, XLEN climbs to the cap
  // and the (cap+1)th enqueue is rejected — proves the fix didn't remove real
  // backpressure protection.
  it("still rejects with pair_queue_overloaded when the consumer is wedged", async () => {
    const restore = config.maxQueueDepth;
    (config as { maxQueueDepth: number }).maxQueueDepth = DEPTH_TEST_CAP;

    // Wedge processing: the consumer awaits this gate inside placeOrderWithSnapshot,
    // so it never acks/XDELs — the stream fills to the cap and stays there.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    try {
      vi.mocked(placeOrderWithSnapshot).mockImplementation(async () => {
        await gate;
        return FAKE_RESULT;
      });

      const pairId = randomUUID();
      // Fire `cap` enqueues without awaiting their (now-blocked) resolution.
      const inflight: Promise<unknown>[] = [];
      for (let i = 0; i < DEPTH_TEST_CAP; i++) {
        inflight.push(
          enqueueRedis(pairId, `u-block-${i}`, payload(pairId), undefined, `req-block-${i}`, undefined, undefined, null).catch(() => {}),
        );
      }
      // Wait until all cap XADDs have landed (none deleted — consumer is wedged).
      await waitFor(async () => (await getRedis()!.xlen(`queue:${pairId}`)) >= DEPTH_TEST_CAP);

      // The (cap+1)th enqueue must hit the depth guard.
      await expect(
        enqueueRedis(pairId, "u-overflow", payload(pairId), undefined, "req-overflow", undefined, undefined, null),
      ).rejects.toThrow("pair_queue_overloaded");

      // Release the wedge; backlog drains and the stream returns to ~0.
      releaseGate();
      await Promise.allSettled(inflight);
      await waitFor(async () => (await getRedis()!.xlen(`queue:${pairId}`)) <= 1);
    } finally {
      releaseGate(); // ensure released even on assertion failure so shutdown isn't blocked
      (config as { maxQueueDepth: number }).maxQueueDepth = restore;
    }
  });
});
