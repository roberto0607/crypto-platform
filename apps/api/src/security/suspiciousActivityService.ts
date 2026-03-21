import type Redis from "ioredis";
import { pool } from "../db/pool";
import { config } from "../config";
import { suspiciousActivityTotal } from "../metrics";
import { auditLog } from "../audit/log";
import { getRedis } from "../db/redis.js";

// ── Interface ──

interface SuspiciousActivityDetector {
  /** Record a cancel/replace event. Returns true if suspicious. */
  recordCancelReplace(userId: string): Promise<boolean>;
  reset(): void;
}

// ── Redis implementation (ZSET) ──

class RedisSuspiciousActivityDetector implements SuspiciousActivityDetector {
  constructor(private redis: Redis) {}

  async recordCancelReplace(userId: string): Promise<boolean> {
    const now = Date.now();
    const windowMs = config.suspiciousOrderWindowMs;
    const threshold = config.suspiciousCancelBurstThreshold;
    const key = `cancelbursts:${userId}`;
    const member = `${now}-${Math.random().toString(36).slice(2, 6)}`;

    const pipeline = this.redis.pipeline();
    pipeline.zadd(key, now.toString(), member);
    pipeline.zremrangebyscore(key, "-inf", (now - windowMs).toString());
    pipeline.zcard(key);
    pipeline.expire(key, Math.ceil(windowMs / 1000) + 10);
    const results = await pipeline.exec();

    // zcard result is at index 2: [err, count]
    const count = (results?.[2]?.[1] as number) ?? 0;
    return count > threshold;
  }

  reset(): void {
    // No-op for Redis — keys auto-expire
  }
}

// ── In-memory implementation ──

class InMemorySuspiciousActivityDetector implements SuspiciousActivityDetector {
  private cancelWindows = new Map<string, number[]>();

  async recordCancelReplace(userId: string): Promise<boolean> {
    const now = Date.now();
    const windowMs = config.suspiciousOrderWindowMs;
    const threshold = config.suspiciousCancelBurstThreshold;

    let timestamps = this.cancelWindows.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.cancelWindows.set(userId, timestamps);
    }

    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    timestamps.push(now);
    return timestamps.length > threshold;
  }

  reset(): void {
    this.cancelWindows.clear();
  }
}

// ── Factory + singleton ──

let _instance: SuspiciousActivityDetector | null = null;

function getInstance(): SuspiciousActivityDetector {
  if (!_instance) {
    const redis = getRedis();
    _instance = redis
      ? new RedisSuspiciousActivityDetector(redis)
      : new InMemorySuspiciousActivityDetector();
  }
  return _instance;
}

/**
 * Record a cancel or replace event. Returns true if suspicious.
 */
export async function recordCancelReplace(userId: string): Promise<boolean> {
  return getInstance().recordCancelReplace(userId);
}

/**
 * Disable trading for a user flagged as suspicious.
 */
export async function flagSuspiciousUser(userId: string, reason: string): Promise<void> {
  // user_quotas table was removed in migration 059 — disable via account_limits instead
  await pool.query(
    `UPDATE account_limits SET account_status = 'SUSPENDED' WHERE user_id = $1`,
    [userId],
  ).catch(() => { /* account_limits row may not exist */ });
  suspiciousActivityTotal.inc();
  await auditLog({
    actorUserId: userId,
    action: "suspicious_activity.detected",
    targetType: "user",
    targetId: userId,
    metadata: { reason },
  });
}

/** Clear all windows (for tests). */
export function resetSuspiciousActivityWindows(): void {
  getInstance().reset();
}
