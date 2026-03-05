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
