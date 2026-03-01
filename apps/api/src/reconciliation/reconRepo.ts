import type { PoolClient } from "pg";
import type { ReconFinding } from "./reconTypes";
import { pool } from "../db/pool";

// ── Types ──

export interface ReconReportRow {
  id: string;
  run_id: string;
  user_id: string | null;
  severity: string;
  check_name: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface ReconReportFilters {
  userId?: string;
  from?: string;
  to?: string;
  severity?: string;
  checkName?: string;
  limit?: number;
  offset?: number;
}

// ── Batch insert findings ──

export async function insertFindingsTx(
  client: PoolClient,
  runId: string,
  findings: ReconFinding[],
): Promise<void> {
  if (findings.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const f of findings) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
    values.push(runId, f.userId, f.severity, f.checkName, JSON.stringify(f.details));
    idx += 5;
  }

  await client.query(
    `INSERT INTO reconciliation_reports (run_id, user_id, severity, check_name, details)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
}

// ── List reports (paginated) ──

export async function listReports(
  filters: ReconReportFilters,
): Promise<{ rows: ReconReportRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${idx++}`);
    params.push(filters.userId);
  }
  if (filters.from) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(filters.to);
  }
  if (filters.severity) {
    conditions.push(`severity = $${idx++}`);
    params.push(filters.severity);
  }
  if (filters.checkName) {
    conditions.push(`check_name = $${idx++}`);
    params.push(filters.checkName);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM reconciliation_reports ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0].cnt, 10);

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const { rows } = await pool.query<ReconReportRow>(
    `SELECT id, run_id, user_id, severity, check_name, details, created_at
     FROM reconciliation_reports
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  return { rows, total };
}

// ── Latest run summary ──

export async function getLatestRunSummary(): Promise<{
  runId: string;
  createdAt: string;
  totalFindings: number;
  highCount: number;
  warnCount: number;
  infoCount: number;
} | null> {
  const { rows } = await pool.query<{
    run_id: string;
    created_at: string;
    total: string;
    high: string;
    warn: string;
    info: string;
  }>(
    `SELECT
       run_id,
       MIN(created_at) AS created_at,
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE severity = 'HIGH')::text AS high,
       COUNT(*) FILTER (WHERE severity = 'WARN')::text AS warn,
       COUNT(*) FILTER (WHERE severity = 'INFO')::text AS info
     FROM reconciliation_reports
     WHERE run_id = (
       SELECT run_id FROM reconciliation_reports ORDER BY created_at DESC LIMIT 1
     )
     GROUP BY run_id`,
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    runId: r.run_id,
    createdAt: r.created_at,
    totalFindings: parseInt(r.total, 10),
    highCount: parseInt(r.high, 10),
    warnCount: parseInt(r.warn, 10),
    infoCount: parseInt(r.info, 10),
  };
}
