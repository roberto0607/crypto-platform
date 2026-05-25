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

// ── Per-consumer blocking-read connections ──
//
// ioredis serializes commands on a single connection, and a blocking
// `XREADGROUP ... BLOCK` holds that connection until it returns. So each queue
// consumer needs its OWN connection for its blocking read loop — otherwise a
// blocking read starves the command connection (enqueue XADDs, result
// PUBLISHes) and other consumers' reads. These are created via a factory (one
// per consumer/pair), not a singleton, and the caller owns their lifecycle.
type BlockingRedisFactory = () => Redis;

const defaultBlockingRedisFactory: BlockingRedisFactory = () =>
  new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    keyPrefix: "cp:", // mirror the command connection — XREADGROUP uses queue:<pairId>
  });

let blockingRedisFactory: BlockingRedisFactory = defaultBlockingRedisFactory;

/**
 * Create a dedicated ioredis connection for a single queue consumer's blocking
 * XREADGROUP loop. One per consumer/pair — never share it, never use it for
 * commands. The caller owns its lifecycle: connect() it, and quit()/disconnect()
 * it when the consumer stops.
 */
export function createBlockingRedis(): Redis {
  return blockingRedisFactory();
}

/**
 * TEST-ONLY — do not call from production code paths.
 *
 * Override the factory used by createBlockingRedis() so integration tests can
 * point consumers' blocking connections at a throwaway instance (config.redisUrl
 * is empty in tests). Pass null to restore the default factory.
 */
export function setBlockingRedisFactory(fn: BlockingRedisFactory | null): void {
  blockingRedisFactory = fn ?? defaultBlockingRedisFactory;
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
