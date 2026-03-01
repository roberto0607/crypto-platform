import { pool } from "../../db/pool";
import { D, toFixed8 } from "../../utils/decimal";
import type { ReconFinding } from "../reconTypes";

const EPS = D("0.00000001");

// ── C2a: wallet.reserved vs SUM of open LIMIT order reserves ──

const RESERVED_VS_ORDERS_SQL = `
  SELECT
    w.id          AS wallet_id,
    w.user_id,
    w.reserved    AS actual_reserved,
    COALESCE(agg.expected_reserved, 0)::NUMERIC(28,8) AS expected_reserved
  FROM wallets w
  LEFT JOIN (
    SELECT
      reserved_wallet_id,
      SUM(reserved_amount - reserved_consumed) AS expected_reserved
    FROM orders
    WHERE type = 'LIMIT'
      AND status IN ('OPEN', 'PARTIALLY_FILLED')
    GROUP BY reserved_wallet_id
  ) agg ON agg.reserved_wallet_id = w.id
`;

// ── C2b: MARKET orders with non-zero reserved_amount ──

const MARKET_RESERVED_SQL = `
  SELECT id, user_id, reserved_amount::text AS reserved_amount
  FROM orders
  WHERE type = 'MARKET'
    AND reserved_amount > 0
`;

// ── Check ──

export async function reservedVsOrdersCheck(): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  // C2a: reserved mismatch
  const { rows: reservedRows } = await pool.query(RESERVED_VS_ORDERS_SQL);

  for (const row of reservedRows) {
    const actual = D(row.actual_reserved);
    const expected = D(row.expected_reserved);
    const diff = actual.minus(expected).abs();

    if (diff.gt(EPS)) {
      findings.push({
        severity: "HIGH",
        checkName: "RESERVED_MISMATCH",
        userId: row.user_id,
        details: {
          walletId: row.wallet_id,
          reserved: toFixed8(actual),
          expectedReserved: toFixed8(expected),
          diff: toFixed8(diff),
        },
      });
    }
  }

  // C2b: MARKET orders with non-zero reserved
  const { rows: marketRows } = await pool.query(MARKET_RESERVED_SQL);

  for (const row of marketRows) {
    findings.push({
      severity: "WARN",
      checkName: "MARKET_RESERVED_NONZERO",
      userId: row.user_id,
      details: {
        orderId: row.id,
        reservedAmount: row.reserved_amount,
      },
    });
  }

  return findings;
}
