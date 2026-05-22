import Redis from "ioredis";
import { config } from "../config.js";

let redis: Redis | null = null;
let redisSub: Redis | null = null;

export function getRedis(): Redis | null {
  return redis;
}

export function getRedisSub(): Redis | null {
  return redisSub;
}

/**
 * TEST-ONLY — do not call from production code paths.
 *
 * Injects the command Redis client so integration tests can point getRedis()
 * at a throwaway instance (e.g. a testcontainers Redis) without going through
 * initRedis()/REDIS_URL. Production must always use initRedis(). Pass null to
 * reset module state during teardown.
 */
export function setRedis(client: Redis | null): void {
  redis = client;
}

/**
 * TEST-ONLY — do not call from production code paths. See setRedis.
 *
 * Injects the subscriber connection (ioredis requires a dedicated connection
 * for subscribe mode, so the result-channel pub/sub round-trip needs this set
 * in addition to setRedis).
 */
export function setRedisSub(client: Redis | null): void {
  redisSub = client;
}

export async function initRedis(): Promise<void> {
  if (!config.redisUrl) return;
  redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    keyPrefix: "cp:",
  });
  redisSub = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  await Promise.all([redis.connect(), redisSub.connect()]);
}

export async function shutdownRedis(): Promise<void> {
  await Promise.all([
    redis?.quit().catch(() => {}),
    redisSub?.quit().catch(() => {}),
  ]);
  redis = null;
  redisSub = null;
}
