import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { config } from "../config";
import { logger as rootLogger } from "../observability/logContext";
import {
    jobRunsTotal,
    jobDurationMs,
    jobLockContentionTotal,
    jobSkippedTotal,
    jobsInflight,
} from "../metrics";
import * as jobRepo from "./jobRepo";
import type { JobDefinition, JobContext } from "./jobTypes";

const logger = rootLogger.child({ module: "jobRunner" });

/*
 * Pool safety. Each in-flight job holds one pooled client for its whole run
 * (its session-level advisory lock lives on that connection), and the job body
 * acquires more clients from the same pool. Before 2026-10, every due job was
 * started at once and the runner's own bookkeeping (markStarted/markFinished)
 * needed a SECOND client per job: with due jobs >= usable clients, every client
 * was held by a runJob waiting for one more, and the pool froze permanently —
 * every request in the process hung behind it. In prod, 18 jobs come due
 * together after >=1h of API downtime, against 20 clients minus 2 held by
 * leader election.
 *
 * Invariants now:
 *   - bookkeeping runs on the client runJob already holds (1 client per job);
 *   - at most `maxConcurrency` jobs are in flight, clamped so that in-flight
 *     lock clients plus the leader-election reserve leave at least as many
 *     free clients again for job bodies and request traffic;
 *   - a job name is never started while it is already in flight;
 *   - a run that can't get a client within `acquireTimeoutMs` is skipped
 *     (it stays due) rather than waiting forever;
 *   - the advisory lock is released before the client goes back to the pool.
 */

/** Clients leader election can hold permanently (outbox, job runner, lock sampler). */
const LEADER_LOCK_RESERVE = 3;

const definitions: Map<string, JobDefinition> = new Map();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let stopping = false;
let ticking = false;
const inflightJobs: Set<Promise<void>> = new Set();
const inflightNames: Set<string> = new Set();
let maxConcurrency = 1;
let acquireTimeoutMs = config.jobAcquireTimeoutMs;

export function registerJobs(defs: JobDefinition[]): void {
    for (const d of defs) {
        definitions.set(d.name, d);
    }
}

/**
 * Largest concurrency that keeps the pool deadlock-free: in-flight lock
 * clients + the leader reserve must leave at least as many clients free for
 * the jobs' own queries (a body may hold one client while needing another).
 */
export function safeMaxConcurrency(poolMax: number): number {
    return Math.max(1, Math.floor((poolMax - LEADER_LOCK_RESERVE) / 2));
}

export async function start(opts: { maxConcurrency?: number; acquireTimeoutMs?: number } = {}): Promise<void> {
    stopping = false;

    const poolMax = pool.options.max ?? config.dbPoolMax;
    const requested = opts.maxConcurrency ?? config.jobMaxConcurrency;
    maxConcurrency = Math.max(1, Math.min(requested, safeMaxConcurrency(poolMax)));
    acquireTimeoutMs = opts.acquireTimeoutMs ?? config.jobAcquireTimeoutMs;
    if (maxConcurrency < requested) {
        logger.warn(
            { requested, maxConcurrency, poolMax },
            "Job concurrency clamped to keep the DB pool deadlock-free",
        );
    }

    // Crash recovery: a row left in RUNNING by a previous process boot is
    // orphaned (its owner is gone). Reset it to FAILED before the loop starts
    // so it becomes due again — without this, findDueJobs's stale-RUNNING arm
    // is the only escape, and this makes recovery immediate on every boot.
    const resetCount = await jobRepo.resetStaleRunningOnStartup();
    logger.info(
        { resetCount },
        resetCount === 1
            ? "Job runner startup: reset 1 stale RUNNING row (was running before this boot)"
            : `Job runner startup: reset ${resetCount} stale RUNNING rows`
    );

    for (const def of definitions.values()) {
        await jobRepo.upsertJobRow(def.name, def.intervalSeconds, true, def.maxRunSeconds ?? null);
    }

    logger.info(
        { jobs: Array.from(definitions.keys()), maxConcurrency, acquireTimeoutMs },
        "Job runner started"
    );

    intervalHandle = setInterval(() => void tick(), 1000);
}

export async function stop(): Promise<void> {
    stopping = true;
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }

    if (inflightJobs.size > 0) {
        logger.info(
            { inflight: inflightJobs.size },
            "Waiting for in-flight jobs to finish…"
        );
        await Promise.allSettled([...inflightJobs]);
    }

    logger.info("Job runner stopped");
}

async function tick(): Promise<void> {
    // Re-entrancy guard: if the previous tick is still waiting on the pool,
    // don't queue another findDueJobs behind it every second.
    if (stopping || ticking) return;
    if (inflightNames.size >= maxConcurrency) return;
    ticking = true;

    try {
        let dueJobs: jobRepo.JobRow[];
        try {
            dueJobs = await jobRepo.findDueJobs();
        } catch (err) {
            logger.error({ err }, "Failed to query due jobs");
            return;
        }

        for (const row of dueJobs) {
            if (stopping) break;
            if (inflightNames.size >= maxConcurrency) break; // rest stay due; picked up as slots free
            const def = definitions.get(row.job_name);
            if (!def) continue;
            if (inflightNames.has(def.name)) continue;

            track(runJob(def, row.last_started_at));
        }
    } finally {
        ticking = false;
    }
}

function track(promise: Promise<unknown>): void {
    const p = promise
        .then(() => undefined)
        .catch((err) => {
            logger.error({ err }, "Job runner error");
        })
        .finally(() => {
            inflightJobs.delete(p);
            // A slot just freed — start the next due job now instead of on the
            // next 1s interval, so a backlog drains at pool speed.
            if (!stopping) setImmediate(() => void tick());
        });
    inflightJobs.add(p);
}

/** pool.connect() with a deadline; null on timeout (a late client is released, never leaked). */
async function connectWithin(ms: number): Promise<PoolClient | null> {
    const pending = pool.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    const winner = await Promise.race([pending, timedOut]);
    clearTimeout(timer);
    if (winner === null) {
        pending.then((c) => c.release()).catch(() => {});
        return null;
    }
    return winner;
}

type RunOutcome = "ran" | "skipped";

async function runJob(def: JobDefinition, expectedStartedAt?: string | Date | null): Promise<RunOutcome> {
    // Registered synchronously (before the first await) so the caller's loop
    // sees it immediately.
    inflightNames.add(def.name);
    jobsInflight.set(inflightNames.size);

    let client: PoolClient | null = null;
    let locked = false;
    try {
        client = await connectWithin(acquireTimeoutMs);
        if (!client) {
            jobSkippedTotal.inc({ job: def.name, reason: "acquire_timeout" });
            logger.warn({ job: def.name, acquireTimeoutMs }, "No DB client within timeout, skipping run");
            return "skipped";
        }

        const lockResult = await client.query<{ pg_try_advisory_lock: boolean }>(
            `SELECT pg_try_advisory_lock(hashtext($1))`,
            [def.name]
        );
        if (!lockResult.rows[0]?.pg_try_advisory_lock) {
            jobLockContentionTotal.inc({ job: def.name });
            logger.debug({ job: def.name }, "Lock contention, skipping");
            return "skipped";
        }
        locked = true;

        // Defensive claim: bail if another worker advanced the row between
        // selection and now (markStarted returns null). triggerJob passes
        // undefined → unconditional claim. See jobRepo.markStarted.
        // Runs on the client we already hold — never a second pool client.
        const claimedAt = await jobRepo.markStarted(def.name, expectedStartedAt, client);
        if (claimedAt === null) {
            logger.info({ job: def.name }, "Job claimed by another worker, skipping");
            return "skipped";
        }

        const timeoutMs = def.timeoutMs ?? 60_000;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);

        const ctx: JobContext = {
            pool,
            logger: logger.child({ job: def.name }),
            signal: ac.signal,
        };

        const startMs = performance.now();
        try {
            await def.run(ctx);
            const durationMs = performance.now() - startMs;
            jobRunsTotal.inc({ job: def.name, status: "success" });
            jobDurationMs.observe({ job: def.name }, durationMs);
            await jobRepo.markFinished(def.name, "SUCCESS", undefined, client);
            ctx.logger.info({ durationMs: Math.round(durationMs) }, "Job completed");
        } catch (err) {
            const durationMs = performance.now() - startMs;
            const errMsg = err instanceof Error ? err.message : String(err);
            jobRunsTotal.inc({ job: def.name, status: "failed" });
            jobDurationMs.observe({ job: def.name }, durationMs);
            await jobRepo.markFinished(def.name, "FAILED", errMsg, client);
            ctx.logger.error({ err, durationMs: Math.round(durationMs) }, "Job failed");
        } finally {
            clearTimeout(timer);
        }
        return "ran";
    } finally {
        if (client) await releaseClient(client, def.name, locked);
        inflightNames.delete(def.name);
        jobsInflight.set(inflightNames.size);
    }
}

/**
 * Session-level advisory locks outlive client.release() — the connection
 * goes back to the pool still holding them, and the next run of the job (on a
 * different pooled session) fails pg_try_advisory_lock and is skipped as
 * "contention". Unlock first; if that fails, destroy the connection instead
 * (closing the session drops its locks).
 */
async function releaseClient(client: PoolClient, jobName: string, locked: boolean): Promise<void> {
    if (!locked) {
        client.release();
        return;
    }
    try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [jobName]);
        client.release();
    } catch (err) {
        logger.warn({ err, job: jobName }, "Advisory unlock failed; discarding connection");
        client.release(err instanceof Error ? err : new Error(String(err)));
    }
}

export async function triggerJob(name: string): Promise<{ status: string; error?: string }> {
    const def = definitions.get(name);
    if (!def) return { status: "NOT_FOUND", error: `Unknown job: ${name}` };
    if (inflightNames.has(name)) {
        return { status: "ALREADY_RUNNING", error: `Job ${name} is already running` };
    }

    const outcome = await runJob(def);
    if (outcome === "skipped") {
        return { status: "SKIPPED", error: "Job could not start (no DB client in time, or locked by another worker)" };
    }

    const row = await jobRepo.getJobRow(name);
    return {
        status: row?.last_status ?? "UNKNOWN",
        error: row?.last_error ?? undefined,
    };
}

/** TEST-ONLY — forget registered jobs and in-flight bookkeeping. */
export function __resetJobRunnerForTest(): void {
    definitions.clear();
    inflightNames.clear();
    inflightJobs.clear();
    stopping = false;
    ticking = false;
}
