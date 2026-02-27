import { pool } from "../db/pool";
import { D, ZERO, toFixed8 } from "../utils/decimal";

// ── Types ──

export interface PositionMismatch {
  userId: string;
  pairId: string;
  pairSymbol: string;
  expectedBaseQty: string;
  actualBaseQty: string;
  delta: string;
}

export interface PositionPnlAnomaly {
  userId: string;
  pairId: string;
  pairSymbol: string;
  reason: string;
}

export interface PositionReconciliationReport {
  positionsChecked: number;
  mismatchedPositions: PositionMismatch[];
  anomalies: PositionPnlAnomaly[];
}

// ── Queries ──

const EXPECTED_QTY_SQL = `
  SELECT user_id, pair_id, pair_symbol,
         SUM(signed_qty)::NUMERIC(28,8) AS expected_base_qty
  FROM (
    SELECT o.user_id, t.pair_id, tp.symbol AS pair_symbol, t.qty AS signed_qty
    FROM trades t
    JOIN orders o ON o.id = t.buy_order_id
    JOIN trading_pairs tp ON tp.id = t.pair_id
    WHERE t.buy_order_id IS NOT NULL

    UNION ALL

    SELECT o.user_id, t.pair_id, tp.symbol AS pair_symbol, -t.qty AS signed_qty
    FROM trades t
    JOIN orders o ON o.id = t.sell_order_id
    JOIN trading_pairs tp ON tp.id = t.pair_id
    WHERE t.sell_order_id IS NOT NULL
  ) sub
  GROUP BY user_id, pair_id, pair_symbol
`;

const ACTUAL_POSITIONS_SQL = `
  SELECT p.user_id, p.pair_id,
         p.base_qty::text   AS base_qty,
         p.avg_entry_price::text AS avg_entry_price,
         tp.symbol AS pair_symbol
  FROM positions p
  JOIN trading_pairs tp ON tp.id = p.pair_id
`;

// ── Reconciliation ──

export async function reconcilePositions(): Promise<PositionReconciliationReport> {
  const [expectedResult, actualResult] = await Promise.all([
    pool.query(EXPECTED_QTY_SQL),
    pool.query(ACTUAL_POSITIONS_SQL),
  ]);

  // Build map of expected qty: key = "userId:pairId"
  const expectedMap = new Map<string, { expectedBaseQty: string; pairSymbol: string }>();
  for (const row of expectedResult.rows) {
    const key = `${row.user_id}:${row.pair_id}`;
    expectedMap.set(key, {
      expectedBaseQty: row.expected_base_qty,
      pairSymbol: row.pair_symbol,
    });
  }

  const mismatchedPositions: PositionMismatch[] = [];
  const anomalies: PositionPnlAnomaly[] = [];

  // Check each actual position against expected
  for (const row of actualResult.rows) {
    const key = `${row.user_id}:${row.pair_id}`;
    const expected = expectedMap.get(key);
    const expectedQty = expected ? D(expected.expectedBaseQty) : ZERO;
    const actualQty = D(row.base_qty);

    if (!expectedQty.eq(actualQty)) {
      mismatchedPositions.push({
        userId: row.user_id,
        pairId: row.pair_id,
        pairSymbol: row.pair_symbol,
        expectedBaseQty: toFixed8(expectedQty),
        actualBaseQty: toFixed8(actualQty),
        delta: toFixed8(expectedQty.minus(actualQty)),
      });
    }

    // Anomaly: avg_entry_price != 0 when base_qty == 0
    if (actualQty.eq(ZERO) && !D(row.avg_entry_price).eq(ZERO)) {
      anomalies.push({
        userId: row.user_id,
        pairId: row.pair_id,
        pairSymbol: row.pair_symbol,
        reason: "NON_ZERO_AVG_ENTRY_WITH_ZERO_QTY",
      });
    }

    // Remove from map so we can detect orphans
    expectedMap.delete(key);
  }

  // Orphans: trades exist but no position row
  for (const [key, val] of expectedMap) {
    const expectedQty = D(val.expectedBaseQty);
    if (!expectedQty.eq(ZERO)) {
      const [userId, pairId] = key.split(":");
      mismatchedPositions.push({
        userId,
        pairId,
        pairSymbol: val.pairSymbol,
        expectedBaseQty: toFixed8(expectedQty),
        actualBaseQty: toFixed8(ZERO),
        delta: toFixed8(expectedQty),
      });
    }
  }

  return {
    positionsChecked: actualResult.rows.length,
    mismatchedPositions,
    anomalies,
  };
}
