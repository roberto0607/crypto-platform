import { pool } from "../db/pool";

export interface JobRow {
    job_name: string;
    is_enabled: boolean;
    interval_seconds: number;
    last_started_at: Date | null;
    last_finished_at: string | null;
    last_status: string | null;
    last_error: string | null;
    next_run_at: string | null;
    max_run_seconds: number | null;
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
    enabled: boolean,
    maxRunSeconds: number | null
): Promise<void> {
    // The job definition in code is authoritative for interval_seconds and
    // max_run_seconds — both are re-applied on every boot via ON CONFLICT.
    // A job that omits maxRunSeconds resets the column to NULL, which
    // findDueJobs() interprets as "use the default" (see COALESCE below).
    await pool.query(
        `INSERT INTO job_runs (job_name, interval_seconds, is_enabled, max_run_seconds, next_run_at)
         VALUES ($1, $2::int, $3, $4, now() + make_interval(secs => $2::int))
         ON CONFLICT (job_name) DO UPDATE
            SET interval_seconds = EXCLUDED.interval_seconds,
                max_run_seconds = EXCLUDED.max_run_seconds`,
        [name, intervalSeconds, enabled, maxRunSeconds]
    );
}

/**
 * Claim a due job for execution by flipping it to RUNNING.
 *
 * Defensive idempotency for the (rare) race where two workers select the
 * same due row before either claims it: the caller passes the last_started_at
 * it observed at selection time as `expectedStartedAt`. The claim succeeds
 * only if the row is unchanged since selection (last_started_at matches) OR is
 * no longer RUNNING — otherwise another worker won the race and we return null
 * so the caller skips this job. IS [NOT] DISTINCT FROM is used for
 * NULL-safety: a never-run job has last_started_at = NULL at selection, which
 * a plain `=` comparison would never match.
 *
 * Compared at MILLISECOND precision (date_trunc on both sides) because
 * node-postgres parses timestamptz into a JS Date (ms resolution) while now()
 * writes microseconds — so the value the caller reads back and passes here is
 * already ms-truncated, and raw equality against the microsecond column would
 * be false on the round-trip even when nothing changed. That false negative
 * would make the stale-RUNNING reclaim path (last_status='RUNNING', so the
 * second arm is false) fail to claim the very row this PR exists to recover.
 * ms granularity is far finer than any real claim race, and the advisory lock
 * in runJob already serializes execution, so it introduces no false claims.
 *
 * Omit `expectedStartedAt` (manual-trigger path, no prior selection) to claim
 * the row unconditionally.
 *
 * Returns the new last_started_at on success, or null if the claim failed.
 */
export async function markStarted(
    name: string,
    expectedStartedAt?: string | Date | null
): Promise<Date | null> {
    if (expectedStartedAt === undefined) {
        const r = await pool.query<{ last_started_at: Date }>(
            `UPDATE job_runs
             SET last_started_at = now(), last_status = 'RUNNING', last_error = NULL
             WHERE job_name = $1
             RETURNING last_started_at`,
            [name]
        );
        return r.rows[0]?.last_started_at ?? null;
    }

    const r = await pool.query<{ last_started_at: Date }>(
        `UPDATE job_runs
         SET last_started_at = now(), last_status = 'RUNNING', last_error = NULL
         WHERE job_name = $1
           AND (date_trunc('milliseconds', last_started_at)
                  IS NOT DISTINCT FROM date_trunc('milliseconds', $2::timestamptz)
                OR last_status IS DISTINCT FROM 'RUNNING')
         RETURNING last_started_at`,
        [name, expectedStartedAt]
    );
    return r.rows[0]?.last_started_at ?? null;
}

/**
 * Crash recovery, run once per process boot before the job loop starts.
 * A row still in RUNNING at startup is orphaned by definition — the process
 * that owned it is gone and markFinished will never run — so flip it back to
 * FAILED to make it due again. Returns the number of rows reset.
 */
export async function resetStaleRunningOnStartup(): Promise<number> {
    const r = await pool.query(
        `UPDATE job_runs
         SET last_status = 'FAILED',
             last_error = 'reset on startup (was RUNNING)'
         WHERE last_status = 'RUNNING'`
    );
    return r.rowCount ?? 0;
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
    // A row is due when enabled, past its next_run_at, AND either not RUNNING
    // OR stale-RUNNING — a run whose last_started_at is older than its
    // staleness ceiling (max_run_seconds, or the default min(interval*5, 300)
    // when NULL). The stale-RUNNING arm is the crash-recovery escape hatch:
    // without it a row left in RUNNING by a dead process is skipped forever
    // (the bug that wedged market-maker for ~2 months).
    const r = await pool.query<JobRow>(
        `SELECT * FROM job_runs
         WHERE is_enabled = true
           AND (next_run_at IS NULL OR next_run_at <= now())
           AND (
                last_status IS DISTINCT FROM 'RUNNING'
                OR last_started_at < now() - COALESCE(max_run_seconds, LEAST(interval_seconds * 5, 300)) * interval '1 second'
           )
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
