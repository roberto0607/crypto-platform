/**
 * quickCallStore.integration.test.ts — the Redis implementation against a real
 * Redis (testcontainers). Covers what the in-memory fallback can't: the Lua
 * compare-and-delete settle claim, SET NX for one-open-call, TTLs, and the
 * per-IP window counter. Run with `pnpm test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { setRedis } from "../../db/redis";
import { quickCallStore, __resetQuickCallStoreForTest, STREAK_TTL_SECONDS, type OpenCall } from "../quickCallStore";

let container: StartedRedisContainer;
let redis: Redis;

const call = (id: string): OpenCall => ({
  id,
  direction: "UP",
  entryPrice: "84000.00",
  entryAt: 1,
  settleAt: 60_001,
});

describe("quickCallStore (Redis)", () => {
  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    // Same keyPrefix shape as the other integration tests, so the Lua
    // script's KEYS[] path is exercised through ioredis's prefixing.
    redis = new Redis(container.getConnectionUrl(), { keyPrefix: "cp:" });
    setRedis(redis);
  });

  afterAll(async () => {
    setRedis(null);
    __resetQuickCallStoreForTest();
    await redis.quit();
    await container.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  function store() {
    // quickCallStore() caches its instance; build it after setRedis.
    return quickCallStore();
  }

  it("allows only one open call per identity (SET NX)", async () => {
    expect(await store().setOpenIfAbsent("anon:a", call("c1"))).toBe(true);
    expect(await store().setOpenIfAbsent("anon:a", call("c2"))).toBe(false);
    expect((await store().getOpen("anon:a"))?.id).toBe("c1");
  });

  it("settle claim succeeds exactly once, and only for the matching call id", async () => {
    await store().setOpenIfAbsent("anon:a", call("c1"));
    expect(await store().claimOpen("anon:a", "other")).toBe(false);
    const claims = await Promise.all([store().claimOpen("anon:a", "c1"), store().claimOpen("anon:a", "c1")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store().getOpen("anon:a")).toBeNull();
  });

  it("stores the streak with a 24h TTL", async () => {
    await store().setStreak("anon:a", 3);
    expect(await store().getStreak("anon:a")).toBe(3);
    const ttl = await redis.ttl("qc:streak:anon:a");
    expect(ttl).toBeGreaterThan(STREAK_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(STREAK_TTL_SECONDS);
  });

  it("keeps the last 20 settled rounds, newest first", async () => {
    for (let i = 0; i < 25; i++) {
      await store().pushHistory("anon:a", {
        id: `c${i}`, direction: "UP", entryPrice: "1", exitPrice: "2", outcome: "WIN", settledAt: i,
      });
    }
    const history = await store().getHistory("anon:a");
    expect(history).toHaveLength(20);
    expect(history[0]!.id).toBe("c24");
  });

  it("deleteIdentity removes open call, streak, and history", async () => {
    await store().setOpenIfAbsent("anon:a", call("c1"));
    await store().setStreak("anon:a", 2);
    await store().pushHistory("anon:a", {
      id: "c0", direction: "UP", entryPrice: "1", exitPrice: "2", outcome: "WIN", settledAt: 0,
    });
    await store().deleteIdentity("anon:a");
    expect(await store().getOpen("anon:a")).toBeNull();
    expect(await store().getStreak("anon:a")).toBe(0);
    expect(await store().getHistory("anon:a")).toEqual([]);
  });

  it("counts calls per IP within the window", async () => {
    expect(await store().incrIp("1.2.3.4")).toBe(1);
    expect(await store().incrIp("1.2.3.4")).toBe(2);
    expect(await store().incrIp("5.6.7.8")).toBe(1);
  });
});
