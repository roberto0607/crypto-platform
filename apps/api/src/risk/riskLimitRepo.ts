import type { PoolClient } from "pg";
import type { RiskLimitRow, EffectiveRiskLimits } from "./riskTypes";

const LIMIT_COLUMNS = `id, user_id, pair_id, max_order_notional_quote, max_position_base_qty, max_open_orders_per_pair, max_price_deviation_bps, created_at, updated_at`;

const SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * Resolve effective limits by 4-level precedence:
 *   (user+pair) > (user+NULL) > (NULL+pair) > (NULL+NULL)
 * For each field, picks the first non-null value walking down the levels.
 */
export async function resolveEffectiveLimits(
  client: PoolClient,
  userId: string,
  pairId: string,
): Promise<EffectiveRiskLimits> {
  const { rows } = await client.query<RiskLimitRow>(
    `SELECT ${LIMIT_COLUMNS}
       FROM risk_limits
      WHERE (user_id = $1 OR user_id IS NULL)
        AND (pair_id = $2 OR pair_id IS NULL)
      ORDER BY
        CASE WHEN user_id IS NOT NULL AND pair_id IS NOT NULL THEN 0
             WHEN user_id IS NOT NULL AND pair_id IS NULL     THEN 1
             WHEN user_id IS NULL     AND pair_id IS NOT NULL THEN 2
             ELSE 3
        END`,
    [userId, pairId],
  );

  // Walk rows in precedence order; pick first non-null for each field
  let maxOrderNotionalQuote: string | null = null;
  let maxPositionBaseQty: string | null = null;
  let maxOpenOrdersPerPair: number | null = null;
  let maxPriceDeviationBps: number | null = null;

  for (const r of rows) {
    if (maxOrderNotionalQuote === null && r.max_order_notional_quote !== null)
      maxOrderNotionalQuote = r.max_order_notional_quote;
    if (maxPositionBaseQty === null && r.max_position_base_qty !== null)
      maxPositionBaseQty = r.max_position_base_qty;
    if (maxOpenOrdersPerPair === null && r.max_open_orders_per_pair !== null)
      maxOpenOrdersPerPair = r.max_open_orders_per_pair;
    if (maxPriceDeviationBps === null && r.max_price_deviation_bps !== null)
      maxPriceDeviationBps = r.max_price_deviation_bps;
  }

  // Fallback hard-coded defaults if nothing found at any level
  return {
    max_order_notional_quote: maxOrderNotionalQuote ?? "100000.00000000",
    max_position_base_qty: maxPositionBaseQty ?? "1000.00000000",
    max_open_orders_per_pair: maxOpenOrdersPerPair ?? 50,
    max_price_deviation_bps: maxPriceDeviationBps ?? 500,
  };
}

/**
 * List all risk limit rows (admin).
 */
export async function listRiskLimits(
  client: PoolClient,
): Promise<RiskLimitRow[]> {
  const { rows } = await client.query<RiskLimitRow>(
    `SELECT ${LIMIT_COLUMNS} FROM risk_limits ORDER BY created_at`,
  );
  return rows;
}

/**
 * Upsert a risk limit row by (user_id, pair_id) scope.
 */
export async function upsertRiskLimit(
  client: PoolClient,
  params: {
    userId: string | null;
    pairId: string | null;
    maxOrderNotionalQuote?: string | null;
    maxPositionBaseQty?: string | null;
    maxOpenOrdersPerPair?: number | null;
    maxPriceDeviationBps?: number | null;
  },
): Promise<RiskLimitRow> {
  const { rows } = await client.query<RiskLimitRow>(
    `INSERT INTO risk_limits (
        user_id, pair_id,
        max_order_notional_quote, max_position_base_qty,
        max_open_orders_per_pair, max_price_deviation_bps
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (
        COALESCE(user_id, '${SENTINEL}'::uuid),
        COALESCE(pair_id, '${SENTINEL}'::uuid)
      )
      DO UPDATE SET
        max_order_notional_quote = COALESCE($3, risk_limits.max_order_notional_quote),
        max_position_base_qty    = COALESCE($4, risk_limits.max_position_base_qty),
        max_open_orders_per_pair = COALESCE($5, risk_limits.max_open_orders_per_pair),
        max_price_deviation_bps  = COALESCE($6, risk_limits.max_price_deviation_bps)
      RETURNING ${LIMIT_COLUMNS}`,
    [
      params.userId,
      params.pairId,
      params.maxOrderNotionalQuote ?? null,
      params.maxPositionBaseQty ?? null,
      params.maxOpenOrdersPerPair ?? null,
      params.maxPriceDeviationBps ?? null,
    ],
  );
  return rows[0];
}
