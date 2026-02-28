import type { PoolClient } from "pg";
import type { AccountLimitRow } from "./governanceTypes";

const LIMIT_COLUMNS = `user_id, max_daily_notional_quote, max_daily_realized_loss_quote, max_open_positions, max_open_orders, account_status, created_at, updated_at`;

/**
 * Fetch account-level governance limits for a user.
 * Returns null if no row exists (no limits configured).
 */
export async function getAccountLimits(
  client: PoolClient,
  userId: string,
): Promise<AccountLimitRow | null> {
  const { rows } = await client.query<AccountLimitRow>(
    `SELECT ${LIMIT_COLUMNS} FROM account_limits WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Upsert account limits. Only non-undefined fields are updated on conflict.
 */
export async function upsertAccountLimits(
  client: PoolClient,
  params: {
    userId: string;
    maxDailyNotionalQuote?: string | null;
    maxDailyRealizedLossQuote?: string | null;
    maxOpenPositions?: number | null;
    maxOpenOrders?: number | null;
  },
): Promise<AccountLimitRow> {
  const { rows } = await client.query<AccountLimitRow>(
    `INSERT INTO account_limits (
        user_id,
        max_daily_notional_quote,
        max_daily_realized_loss_quote,
        max_open_positions,
        max_open_orders
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id)
      DO UPDATE SET
        max_daily_notional_quote   = COALESCE($2, account_limits.max_daily_notional_quote),
        max_daily_realized_loss_quote = COALESCE($3, account_limits.max_daily_realized_loss_quote),
        max_open_positions         = COALESCE($4, account_limits.max_open_positions),
        max_open_orders            = COALESCE($5, account_limits.max_open_orders)
      RETURNING ${LIMIT_COLUMNS}`,
    [
      params.userId,
      params.maxDailyNotionalQuote ?? null,
      params.maxDailyRealizedLossQuote ?? null,
      params.maxOpenPositions ?? null,
      params.maxOpenOrders ?? null,
    ],
  );
  return rows[0];
}

/**
 * Update account status (ACTIVE | SUSPENDED | LOCKED).
 * Creates the row if it doesn't exist yet.
 */
export async function updateAccountStatus(
  client: PoolClient,
  userId: string,
  status: string,
): Promise<AccountLimitRow> {
  const { rows } = await client.query<AccountLimitRow>(
    `INSERT INTO account_limits (user_id, account_status)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET account_status = $2
      RETURNING ${LIMIT_COLUMNS}`,
    [userId, status],
  );
  return rows[0];
}

/**
 * Sum of notional (quote_amount) traded by user for the current UTC day.
 * Joins trades → orders to resolve user ownership.
 */
export async function getDailyNotional(
  client: PoolClient,
  userId: string,
  utcDayStartMs: number,
): Promise<string> {
  const { rows } = await client.query<{ daily_notional: string }>(
    `SELECT COALESCE(SUM(t.quote_amount), 0) AS daily_notional
       FROM trades t
       JOIN orders o ON (o.id = t.buy_order_id OR o.id = t.sell_order_id)
      WHERE o.user_id = $1
        AND t.executed_at >= to_timestamp($2 / 1000.0)`,
    [userId, utcDayStartMs],
  );
  return rows[0].daily_notional;
}

/**
 * Compute today's realized PnL delta.
 *
 * current total = SUM(positions.realized_pnl_quote)
 * baseline      = last equity_snapshots.realized_pnl_quote before UTC day start
 * delta         = current - baseline
 *
 * Returns the delta as a string (negative means loss).
 */
export async function getDailyRealizedLoss(
  client: PoolClient,
  userId: string,
  utcDayStartMs: number,
): Promise<string> {
  // Current cumulative realized PnL across all positions
  const { rows: currentRows } = await client.query<{ current_rpnl: string }>(
    `SELECT COALESCE(SUM(realized_pnl_quote), 0) AS current_rpnl
       FROM positions
      WHERE user_id = $1`,
    [userId],
  );
  const currentRpnl = currentRows[0].current_rpnl;

  // Baseline: last equity snapshot before today's UTC boundary
  const { rows: baselineRows } = await client.query<{ baseline_rpnl: string }>(
    `SELECT COALESCE(realized_pnl_quote, 0) AS baseline_rpnl
       FROM equity_snapshots
      WHERE user_id = $1 AND ts < $2
      ORDER BY ts DESC
      LIMIT 1`,
    [userId, utcDayStartMs],
  );
  const baselineRpnl = baselineRows[0]?.baseline_rpnl ?? "0";

  // Return delta as raw numeric string; caller interprets sign
  const { rows: deltaRows } = await client.query<{ delta: string }>(
    `SELECT ($1::numeric - $2::numeric) AS delta`,
    [currentRpnl, baselineRpnl],
  );
  return deltaRows[0].delta;
}

/**
 * Count distinct pairs where user holds a non-zero position.
 */
export async function getOpenPositionCount(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM positions
      WHERE user_id = $1 AND base_qty != 0`,
    [userId],
  );
  return parseInt(rows[0].cnt, 10);
}

/**
 * Count orders with status OPEN or PARTIALLY_FILLED (global, cross-pair).
 */
export async function getOpenOrderCount(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM orders
      WHERE user_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
    [userId],
  );
  return parseInt(rows[0].cnt, 10);
}

/**
 * Check if user already has an existing position for a specific pair.
 */
export async function hasPositionForPair(
  client: PoolClient,
  userId: string,
  pairId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM positions
      WHERE user_id = $1 AND pair_id = $2 AND base_qty != 0`,
    [userId, pairId],
  );
  return parseInt(rows[0].cnt, 10) > 0;
}
