import { pool } from "../db/pool";
import { AppError } from "../errors/AppError";
import { isGlobalTradingEnabled, isPairTradingEnabled } from "./systemFlagService";
import { checkBurst } from "./burstDetector";
import {
  quotaExceededTotal,
  tradingPausedTotal,
  userTradingDisabledTotal,
  suspiciousActivityTotal,
} from "../metrics";
import { auditLog } from "../audit/log";

export interface QuotaRow {
  user_id: string;
  max_orders_per_min: number;
  max_open_orders: number;
  max_daily_orders: number;
  trading_enabled: boolean;
  updated_at: string;
}

export async function getOrCreateQuota(userId: string): Promise<QuotaRow> {
  await pool.query(
    `INSERT INTO user_quotas (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const result = await pool.query<QuotaRow>(
    `SELECT * FROM user_quotas WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0];
}

export async function updateQuotas(
  userId: string,
  updates: Partial<Pick<QuotaRow, "max_orders_per_min" | "max_open_orders" | "max_daily_orders" | "trading_enabled">>,
): Promise<QuotaRow> {
  await pool.query(
    `INSERT INTO user_quotas (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 2;

  if (updates.max_orders_per_min !== undefined) {
    fields.push(`max_orders_per_min = $${idx++}`);
    values.push(updates.max_orders_per_min);
  }
  if (updates.max_open_orders !== undefined) {
    fields.push(`max_open_orders = $${idx++}`);
    values.push(updates.max_open_orders);
  }
  if (updates.max_daily_orders !== undefined) {
    fields.push(`max_daily_orders = $${idx++}`);
    values.push(updates.max_daily_orders);
  }
  if (updates.trading_enabled !== undefined) {
    fields.push(`trading_enabled = $${idx++}`);
    values.push(updates.trading_enabled);
  }

  if (fields.length === 0) {
    return getOrCreateQuota(userId);
  }

  const result = await pool.query<QuotaRow>(
    `UPDATE user_quotas SET ${fields.join(", ")} WHERE user_id = $1 RETURNING *`,
    [userId, ...values],
  );
  return result.rows[0];
}

async function checkTradingEnabled(userId: string, quota: QuotaRow): Promise<void> {
  if (!quota.trading_enabled) {
    userTradingDisabledTotal.inc();
    throw new AppError("user_trading_disabled");
  }
}

async function checkOpenOrders(userId: string, quota: QuotaRow): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM orders
     WHERE user_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
    [userId],
  );
  const count = parseInt(result.rows[0].count, 10);
  if (count >= quota.max_open_orders) {
    quotaExceededTotal.inc({ type: "OPEN_ORDERS" });
    throw new AppError("quota_exceeded", { type: "OPEN_ORDERS" });
  }
}

async function checkDailyOrders(userId: string, quota: QuotaRow): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM orders
     WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [userId],
  );
  const count = parseInt(result.rows[0].count, 10);
  if (count >= quota.max_daily_orders) {
    quotaExceededTotal.inc({ type: "DAILY_LIMIT" });
    throw new AppError("quota_exceeded", { type: "DAILY_LIMIT" });
  }
}

async function checkOrderRate(userId: string, quota: QuotaRow): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM orders
     WHERE user_id = $1 AND created_at >= now() - interval '1 minute'`,
    [userId],
  );
  const count = parseInt(result.rows[0].count, 10);
  if (count >= quota.max_orders_per_min) {
    quotaExceededTotal.inc({ type: "RATE" });
    throw new AppError("quota_exceeded", { type: "RATE" });
  }
}

export async function enforcePreOrderChecks(userId: string, pairId: string): Promise<void> {
  // 1. Global kill switch
  const globalEnabled = await isGlobalTradingEnabled();
  if (!globalEnabled) {
    tradingPausedTotal.inc({ scope: "global" });
    throw new AppError("trading_paused_global");
  }

  // 2. Per-pair kill switch
  const pairEnabled = await isPairTradingEnabled(pairId);
  if (!pairEnabled) {
    tradingPausedTotal.inc({ scope: "pair" });
    throw new AppError("trading_paused_pair");
  }

  // 3. Per-user quota checks
  const quota = await getOrCreateQuota(userId);
  await checkTradingEnabled(userId, quota);
  await checkOpenOrders(userId, quota);
  await checkDailyOrders(userId, quota);
  await checkOrderRate(userId, quota);

  // 4. Burst detection
  const bursted = checkBurst(userId);
  if (bursted) {
    // Disable trading for this user
    await pool.query(
      `UPDATE user_quotas SET trading_enabled = false WHERE user_id = $1`,
      [userId],
    );
    suspiciousActivityTotal.inc();
    await auditLog({
      actorUserId: userId,
      action: "suspicious_activity.burst_detected",
      targetType: "user",
      targetId: userId,
      metadata: { reason: "order_burst" },
    });
    throw new AppError("suspicious_activity");
  }
}
