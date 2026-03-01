import { pool } from "../../db/pool";
import type { ReconFinding } from "../reconTypes";

// ── C4a: order ownership — order missing or user_id mismatch ──

const OWNERSHIP_SQL = `
  SELECT ik.user_id, ik.key, ik.order_id, o.user_id AS order_user_id
  FROM idempotency_keys ik
  LEFT JOIN orders o ON o.id = ik.order_id
  WHERE o.id IS NULL OR o.user_id != ik.user_id
`;

// ── C4b: snapshot_json missing required keys (last, ts, source) ──

const SNAPSHOT_SQL = `
  SELECT ik.user_id, ik.key, ik.order_id
  FROM idempotency_keys ik
  WHERE ik.snapshot_json IS NULL
     OR ik.snapshot_json = '{}'::jsonb
     OR NOT (
       ik.snapshot_json ? 'last'
       AND ik.snapshot_json ? 'ts'
       AND ik.snapshot_json ? 'source'
     )
`;

// ── Check ──

export async function idempotencyIntegrityCheck(): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  // C4a: ownership
  const { rows: ownershipRows } = await pool.query(OWNERSHIP_SQL);

  for (const row of ownershipRows) {
    findings.push({
      severity: "HIGH",
      checkName: "IDEMPOTENCY_ORDER_OWNERSHIP_FAIL",
      userId: row.user_id,
      details: {
        key: row.key,
        orderId: row.order_id,
        expectedUserId: row.user_id,
        actualUserId: row.order_user_id ?? null,
      },
    });
  }

  // C4b: missing snapshot keys
  const { rows: snapshotRows } = await pool.query(SNAPSHOT_SQL);

  for (const row of snapshotRows) {
    findings.push({
      severity: "WARN",
      checkName: "IDEMPOTENCY_SNAPSHOT_MISSING",
      userId: row.user_id,
      details: {
        key: row.key,
        orderId: row.order_id,
      },
    });
  }

  return findings;
}
