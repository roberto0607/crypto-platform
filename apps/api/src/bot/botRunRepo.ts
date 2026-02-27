import { pool } from "../db/pool";
import type { StrategyRunRow, StrategySignalRow } from "./botTypes";

/* ── Column lists ─────────────────────────────── */

const RUN_COLUMNS = `id, user_id, pair_id, mode, status, started_at, stopped_at, last_tick_ts, params_json, error_message, created_at, updated_at`;

const SIGNAL_COLUMNS = `id, run_id, ts, kind, side, confidence, payload_json, created_at`;

/* ── Runs ─────────────────────────────────────── */

export async function insertRun(
    userId: string,
    pairId: string,
    mode: string,
    paramsJson: object
): Promise<StrategyRunRow> {
    const result = await pool.query<StrategyRunRow>(
        `
        INSERT INTO strategy_runs (user_id, pair_id, mode, params_json)
        VALUES ($1, $2, $3, $4)
        RETURNING ${RUN_COLUMNS}
        `,
        [userId, pairId, mode, JSON.stringify(paramsJson)]
    );
    return result.rows[0];
}

export async function getRunById(runId: string): Promise<StrategyRunRow | null> {
    const result = await pool.query<StrategyRunRow>(
        `SELECT ${RUN_COLUMNS} FROM strategy_runs WHERE id = $1 LIMIT 1`,
        [runId]
    );
    return result.rows[0] ?? null;
}

export async function getRunByIdForUser(
    userId: string,
    runId: string
): Promise<StrategyRunRow | null> {
    const result = await pool.query<StrategyRunRow>(
        `SELECT ${RUN_COLUMNS} FROM strategy_runs WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [runId, userId]
    );
    return result.rows[0] ?? null;
}

export async function listRunsByUser(
    userId: string,
    limit: number,
    cursor: { ca: string; id: string } | null
): Promise<StrategyRunRow[]> {
    let query = `SELECT ${RUN_COLUMNS} FROM strategy_runs WHERE user_id = $1`;
    const params: (string | number)[] = [userId];

    if (cursor) {
        params.push(cursor.ca);
        const caIdx = params.length;
        params.push(cursor.id);
        const idIdx = params.length;
        query += ` AND (created_at, id) < ($${caIdx}, $${idIdx})`;
    }

    params.push(limit + 1);
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const result = await pool.query<StrategyRunRow>(query, params);
    return result.rows;
}

export async function updateRunStatus(
    runId: string,
    status: string,
    extra?: { stopped_at?: string; last_tick_ts?: number; error_message?: string }
): Promise<StrategyRunRow | null> {
    const sets: string[] = ["status = $1"];
    const params: (string | number | null)[] = [status];

    if (extra?.stopped_at !== undefined) {
        params.push(extra.stopped_at);
        sets.push(`stopped_at = $${params.length}`);
    }

    if (extra?.last_tick_ts !== undefined) {
        params.push(extra.last_tick_ts);
        sets.push(`last_tick_ts = $${params.length}`);
    }

    if (extra?.error_message !== undefined) {
        params.push(extra.error_message);
        sets.push(`error_message = $${params.length}`);
    }

    params.push(runId);

    const result = await pool.query<StrategyRunRow>(
        `
        UPDATE strategy_runs
        SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING ${RUN_COLUMNS}
        `,
        params
    );
    return result.rows[0] ?? null;
}

export async function getActiveRunsForPair(pairId: string): Promise<StrategyRunRow[]> {
    const result = await pool.query<StrategyRunRow>(
        `SELECT ${RUN_COLUMNS} FROM strategy_runs WHERE pair_id = $1 AND status = 'RUNNING' ORDER BY created_at ASC`,
        [pairId]
    );
    return result.rows;
}

/* ── Signals ──────────────────────────────────── */

export async function insertSignal(
    runId: string,
    ts: number,
    kind: string,
    side: string | null,
    confidence: string | null,
    payloadJson: object
): Promise<StrategySignalRow> {
    const result = await pool.query<StrategySignalRow>(
        `
        INSERT INTO strategy_signals (run_id, ts, kind, side, confidence, payload_json)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING ${SIGNAL_COLUMNS}
        `,
        [runId, ts, kind, side, confidence, JSON.stringify(payloadJson)]
    );
    return result.rows[0];
}

export async function listSignalsByRun(
    runId: string,
    limit: number,
    cursor: { ts: number; id: string } | null
): Promise<StrategySignalRow[]> {
    let query = `SELECT ${SIGNAL_COLUMNS} FROM strategy_signals WHERE run_id = $1`;
    const params: (string | number)[] = [runId];

    if (cursor) {
        params.push(cursor.ts);
        const tsIdx = params.length;
        params.push(cursor.id);
        const idIdx = params.length;
        query += ` AND (ts, id) < ($${tsIdx}, $${idIdx})`;
    }

    params.push(limit + 1);
    query += ` ORDER BY ts DESC, id DESC LIMIT $${params.length}`;

    const result = await pool.query<StrategySignalRow>(query, params);
    return result.rows;
}
