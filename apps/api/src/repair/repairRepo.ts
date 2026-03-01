import type { PoolClient } from "pg";
import type { RepairPlan } from "./repairTypes";
import { pool } from "../db/pool";

// ── Types ──

export interface RepairRunRow {
  id: string;
  started_by: string | null;
  target_user_id: string;
  mode: string;
  scope: string;
  pair_id: string | null;
  status: string;
  summary: Record<string, unknown>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const REPAIR_RUN_COLUMNS = `id, started_by, target_user_id, mode, scope, pair_id, status, summary, error, created_at, finished_at`;

// ── Create repair run ──

export async function createRepairRunTx(
  client: PoolClient,
  plan: RepairPlan,
  startedBy: string,
): Promise<string> {
  const scope = plan.pairId ? "USER_PAIR" : "USER_ALL_PAIRS";

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO repair_runs (started_by, target_user_id, mode, scope, pair_id, from_ts, to_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [startedBy, plan.targetUserId, plan.mode, scope, plan.pairId ?? null, plan.fromTs ?? null, plan.toTs ?? null],
  );

  return rows[0].id;
}

// ── Mark success ──

export async function markRepairRunSuccessTx(
  client: PoolClient,
  repairRunId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE repair_runs
     SET status = 'SUCCESS', summary = $2, finished_at = now()
     WHERE id = $1`,
    [repairRunId, JSON.stringify(summary)],
  );
}

// ── Mark failed ──

export async function markRepairRunFailedTx(
  client: PoolClient,
  repairRunId: string,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE repair_runs
     SET status = 'FAILED', error = $2, finished_at = now()
     WHERE id = $1`,
    [repairRunId, error],
  );
}

// ── List repair runs (paginated) ──

export async function listRepairRuns(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<{ rows: RepairRunRow[]; total: number }> {
  const countResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM repair_runs WHERE target_user_id = $1`,
    [userId],
  );
  const total = parseInt(countResult.rows[0].cnt, 10);

  const { rows } = await pool.query<RepairRunRow>(
    `SELECT ${REPAIR_RUN_COLUMNS}
     FROM repair_runs
     WHERE target_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );

  return { rows, total };
}
