import { pool } from "../db/pool";
import { config } from "../config";
import { suspiciousActivityTotal } from "../metrics";
import { auditLog } from "../audit/log";

/** In-memory sliding window tracking cancel/replace loops per user. */
const cancelWindows = new Map<string, number[]>();

/**
 * Record a cancel or replace event. Returns true if suspicious.
 */
export function recordCancelReplace(userId: string): boolean {
  const now = Date.now();
  const windowMs = config.suspiciousOrderWindowMs;
  const threshold = config.suspiciousCancelBurstThreshold;

  let timestamps = cancelWindows.get(userId);
  if (!timestamps) {
    timestamps = [];
    cancelWindows.set(userId, timestamps);
  }

  // Prune expired entries
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }

  timestamps.push(now);
  return timestamps.length > threshold;
}

/**
 * Disable trading for a user flagged as suspicious.
 */
export async function flagSuspiciousUser(userId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE user_quotas SET trading_enabled = false WHERE user_id = $1`,
    [userId],
  );
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
  cancelWindows.clear();
}
