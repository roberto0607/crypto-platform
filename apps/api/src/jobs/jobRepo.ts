import { pool } from "../db/pool";

export interface JobRow {
    job_name: string;
    is_enabled: boolean;
    interval_seconds: number;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_status: string | null;
    last_error: string | null;
    next_run_at: string | null;
    updated_at: string;
}

export async function getJobRow(name: string): Promise<JobRow | null> {
    const r = await pool.query<JobRow>(
        `SELECT * FROM job_runs WHERE job_name = $1`,
        [name]
    );
    return r.rows[0] ?? null;
}

export async function getAllJobRows(): Promise<JobRow[]> {
    const r = await pool.query<JobRow>(
        `SELECT * FROM job_runs ORDER BY job_name`
    );
    return r.rows;
}

export async function upsertJobRow(
    name: string,
    intervalSeconds: number,
    enabled: boolean
): Promise<void> {
    await pool.query(
        `INSERT INTO job_runs (job_name, interval_seconds, is_enabled, next_run_at)
         VALUES ($1, $2::int, $3, now() + make_interval(secs => $2::int))
         ON CONFLICT (job_name) DO UPDATE
            SET interval_seconds = EXCLUDED.interval_seconds`,
        [name, intervalSeconds, enabled]
    );
}

export async function markStarted(name: string): Promise<void> {
    await pool.query(
        `UPDATE job_runs
         SET last_started_at = now(), last_status = 'RUNNING', last_error = NULL
         WHERE job_name = $1`,
        [name]
    );
}

export async function markFinished(
    name: string,
    status: "SUCCESS" | "FAILED",
    error?: string
): Promise<void> {
    await pool.query(
        `UPDATE job_runs
         SET last_finished_at = now(),
             last_status = $2,
             last_error = $3,
             next_run_at = now() + make_interval(secs => interval_seconds)
         WHERE job_name = $1`,
        [name, status, error ?? null]
    );
}

export async function findDueJobs(): Promise<JobRow[]> {
    const r = await pool.query<JobRow>(
        `SELECT * FROM job_runs
         WHERE is_enabled = true
           AND (next_run_at IS NULL OR next_run_at <= now())
           AND (last_status IS DISTINCT FROM 'RUNNING')
         ORDER BY next_run_at ASC NULLS FIRST`
    );
    return r.rows;
}

export async function updateJobConfig(
    name: string,
    updates: { is_enabled?: boolean; interval_seconds?: number }
): Promise<JobRow | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (updates.is_enabled !== undefined) {
        sets.push(`is_enabled = $${idx++}`);
        vals.push(updates.is_enabled);
    }
    if (updates.interval_seconds !== undefined) {
        sets.push(`interval_seconds = $${idx++}`);
        vals.push(updates.interval_seconds);
    }
    if (sets.length === 0) return getJobRow(name);

    vals.push(name);
    const r = await pool.query<JobRow>(
        `UPDATE job_runs SET ${sets.join(", ")} WHERE job_name = $${idx} RETURNING *`,
        vals
    );
    return r.rows[0] ?? null;
}
