import type Redis from "ioredis";
import { getRedis } from "../db/redis.js";

const DEFAULT_MAX_ATTEMPTS = 120;
const DEFAULT_WINDOW_MS = 60_000;

const maxAttempts = parseInt(process.env.RATE_ABUSE_MAX_ATTEMPTS ?? "", 10) || DEFAULT_MAX_ATTEMPTS;
const windowMs = parseInt(process.env.RATE_ABUSE_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS;

// ── Interface ──

export interface RateLimiter {
  recordAttempt(userId: string): Promise<void>;
  getAttemptCount(userId: string): Promise<number>;
  isAboveThreshold(userId: string): Promise<boolean>;
}

// ── Redis implementation (ZSET) ──

class RedisRateLimiter implements RateLimiter {
  constructor(private redis: Redis) {}

  async recordAttempt(userId: string): Promise<void> {
    const now = Date.now();
    const key = `rate:${userId}`;
    const member = `${now}-${Math.random().toString(36).slice(2, 6)}`;
    const pipeline = this.redis.pipeline();
    pipeline.zadd(key, now.toString(), member);
    pipeline.zremrangebyscore(key, "-inf", (now - windowMs).toString());
    pipeline.expire(key, Math.ceil(windowMs / 1000) + 10);
    await pipeline.exec();
  }

  async getAttemptCount(userId: string): Promise<number> {
    const now = Date.now();
    const key = `rate:${userId}`;
    return this.redis.zcount(key, (now - windowMs).toString(), "+inf");
  }

  async isAboveThreshold(userId: string): Promise<boolean> {
    const count = await this.getAttemptCount(userId);
    return count >= maxAttempts;
  }
}

// ── In-memory implementation (existing Map logic) ──

class InMemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, number[]>();

  async recordAttempt(userId: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - windowMs;

    let timestamps = this.windows.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(userId, timestamps);
    }

    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    timestamps.push(now);
  }

  async getAttemptCount(userId: string): Promise<number> {
    const now = Date.now();
    const cutoff = now - windowMs;

    const timestamps = this.windows.get(userId);
    if (!timestamps) return 0;

    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid === -1) {
      timestamps.length = 0;
      return 0;
    }
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }

    return timestamps.length;
  }

  async isAboveThreshold(userId: string): Promise<boolean> {
    const count = await this.getAttemptCount(userId);
    return count >= maxAttempts;
  }
}

// ── Factory + singleton ──

function createRateLimiter(): RateLimiter {
  const redis = getRedis();
  if (redis) return new RedisRateLimiter(redis);
  return new InMemoryRateLimiter();
}

let _instance: RateLimiter | null = null;

function getInstance(): RateLimiter {
  if (!_instance) _instance = createRateLimiter();
  return _instance;
}

// ── Public API (preserves same export names, now async) ──

export async function recordAttempt(userId: string): Promise<void> {
  return getInstance().recordAttempt(userId);
}

export async function getAttemptCount(userId: string): Promise<number> {
  return getInstance().getAttemptCount(userId);
}

export async function isAboveThreshold(userId: string): Promise<boolean> {
  return getInstance().isAboveThreshold(userId);
}

/** Exported for testing. */
export const CONFIG = { maxAttempts, windowMs } as const;
