import { pool } from "../../db/pool";
import { D, ZERO, toFixed8 } from "../../utils/decimal";
import type { ReconFinding } from "../reconTypes";

const EPS = D("0.00000001");

// ── Expected net qty from trades (with 10s freshness window) ──

const EXPECTED_QTY_SQL = `
  SELECT user_id, pair_id,
         SUM(signed_qty)::NUMERIC(28,8) AS expected_base_qty
  FROM (
    SELECT o.user_id, t.pair_id, t.qty AS signed_qty
    FROM trades t
    JOIN orders o ON o.id = t.buy_order_id
    WHERE t.buy_order_id IS NOT NULL
      AND t.executed_at <= now() - INTERVAL '10 seconds'

    UNION ALL

    SELECT o.user_id, t.pair_id, -t.qty AS signed_qty
    FROM trades t
    JOIN orders o ON o.id = t.sell_order_id
    WHERE t.sell_order_id IS NOT NULL
      AND t.executed_at <= now() - INTERVAL '10 seconds'
  ) sub
  GROUP BY user_id, pair_id
`;

const ACTUAL_POSITIONS_SQL = `
  SELECT user_id, pair_id, base_qty::text AS base_qty
  FROM positions
`;

// ── Check ──

export async function positionsVsTradesCheck(): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  const [expectedResult, actualResult] = await Promise.all([
    pool.query(EXPECTED_QTY_SQL),
    pool.query(ACTUAL_POSITIONS_SQL),
  ]);

  // Build map: "userId:pairId" → expectedBaseQty
  const expectedMap = new Map<string, string>();
  for (const row of expectedResult.rows) {
    expectedMap.set(`${row.user_id}:${row.pair_id}`, row.expected_base_qty);
  }

  // Check each actual position against expected
  for (const row of actualResult.rows) {
    const key = `${row.user_id}:${row.pair_id}`;
    const expectedQty = expectedMap.get(key);
    const expected = expectedQty ? D(expectedQty) : ZERO;
    const actual = D(row.base_qty);
    const diff = actual.minus(expected).abs();

    if (diff.gt(EPS)) {
      findings.push({
        severity: "HIGH",
        checkName: "POSITION_NET_QTY_MISMATCH",
        userId: row.user_id,
        details: {
          pairId: row.pair_id,
          expectedBaseQty: toFixed8(expected),
          actualBaseQty: toFixed8(actual),
          diff: toFixed8(diff),
        },
      });
    }

    expectedMap.delete(key);
  }

  // Orphans: trades exist but no position row
  for (const [key, expectedQty] of expectedMap) {
    const expected = D(expectedQty);
    if (expected.abs().gt(EPS)) {
      const [userId, pairId] = key.split(":");
      findings.push({
        severity: "HIGH",
        checkName: "POSITION_NET_QTY_MISMATCH",
        userId,
        details: {
          pairId,
          expectedBaseQty: toFixed8(expected),
          actualBaseQty: toFixed8(ZERO),
          diff: toFixed8(expected.abs()),
        },
      });
    }
  }

  return findings;
}
