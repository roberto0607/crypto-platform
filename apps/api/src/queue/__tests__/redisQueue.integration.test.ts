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

import { setRedis, setRedisSub, getRedis } from "../../db/redis";
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

let container: StartedRedisContainer;
let cmd: Redis;
let sub: Redis;

// All tests deliberately share ONE pairId — DO NOT shard this across multiple
// pairs to "isolate" tests. It will look cleaner and then hang/time out.
//
// Why: ioredis runs every command over a single connection, and a blocking
// XREADGROUP holds that connection until it returns. The queue runs one
// consumer per pair, each looping `XREADGROUP ... BLOCK 5000`. With multiple
// pairs, multiple idle consumers stack blocking reads on the shared command
// connection and starve each other — an enqueue on pair B can't get its XADD
// through while pair A's consumer is mid-BLOCK, so it times out. (That failure
// is exactly how this test surfaced the latent prod issue documented in the
// PR's BACKLOG section: "ioredis connection contention under blocking reads".)
//
// One pair = one consumer = one blocking loop, so each enqueue waits at most a
// single ~5s idle-block cycle — well under the queue timeout.
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
    // Subscribe to the result channel so enqueueRedis promises can resolve.
    await initRedisQueue();
  }, 120_000);

  afterAll(async () => {
    // Generous timeout: a consumer mid-BLOCK takes up to READ_BLOCK_MS (5s) to
    // notice the stop signal before it removes itself and the wait can finish.
    await shutdownRedisQueue(8_000);
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
});
