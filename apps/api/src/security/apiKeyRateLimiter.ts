import type Redis from "ioredis";
import { config } from "../config";
import { getRedis } from "../db/redis.js";

const WINDOW_MS = 60_000; // 1 minute

// ── Interface ──

interface ApiKeyRateLimiter {
  /** Returns true if rate limit exceeded. */
  check(apiKeyId: string): Promise<boolean>;
  reset(): void;
}

// ── Redis implementation (ZSET) ──

class RedisApiKeyRateLimiter implements ApiKeyRateLimiter {
  constructor(private redis: Redis) {}

  async check(apiKeyId: string): Promise<boolean> {
    const now = Date.now();
    const key = `apikeyrate:${apiKeyId}`;
    const member = `${now}-${Math.random().toString(36).slice(2, 6)}`;
    const max = config.maxApiKeyReqPerMin;

    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", (now - WINDOW_MS).toString());
    pipeline.zcard(key);
    pipeline.zadd(key, now.toString(), member);
    pipeline.expire(key, Math.ceil(WINDOW_MS / 1000) + 10);
    const results = await pipeline.exec();

    // zcard result is at index 1: [err, count]
    const count = (results?.[1]?.[1] as number) ?? 0;
    if (count >= max) {
      // Remove the member we just speculatively added
      await this.redis.zrem(key, member);
      return true;
    }
    return false;
  }

  reset(): void {
    // No-op for Redis — keys auto-expire
  }
}

// ── In-memory implementation ──

class InMemoryApiKeyRateLimiter implements ApiKeyRateLimiter {
  private windows = new Map<string, number[]>();

  async check(apiKeyId: string): Promise<boolean> {
    const now = Date.now();
    const max = config.maxApiKeyReqPerMin;

    let timestamps = this.windows.get(apiKeyId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(apiKeyId, timestamps);
    }

    const cutoff = now - WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      return true;
    }

    timestamps.push(now);
    return false;
  }

  reset(): void {
    this.windows.clear();
  }
}

// ── Factory + singleton ──

let _instance: ApiKeyRateLimiter | null = null;

function getInstance(): ApiKeyRateLimiter {
  if (!_instance) {
    const redis = getRedis();
    _instance = redis ? new RedisApiKeyRateLimiter(redis) : new InMemoryApiKeyRateLimiter();
  }
  return _instance;
}

/**
 * Record a request for the given API key.
 * Returns true if rate limit exceeded.
 */
export async function checkApiKeyRateLimit(apiKeyId: string): Promise<boolean> {
  return getInstance().check(apiKeyId);
}

/** Clear all windows (for tests). */
export function resetApiKeyRateLimiter(): void {
  getInstance().reset();
}
