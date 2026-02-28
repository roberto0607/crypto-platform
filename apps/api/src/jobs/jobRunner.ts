import { pool } from "../db/pool";
import { logger as rootLogger } from "../observability/logContext";
import {
    jobRunsTotal,
    jobDurationMs,
    jobLockContentionTotal,
} from "../metrics";
import * as jobRepo from "./jobRepo";
import type { JobDefinition, JobContext } from "./jobTypes";

const logger = rootLogger.child({ module: "jobRunner" });

const definitions: Map<string, JobDefinition> = new Map();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let stopping = false;
const inflightJobs: Set<Promise<void>> = new Set();

export function registerJobs(defs: JobDefinition[]): void {
    for (const d of defs) {
        definitions.set(d.name, d);
    }
}

export async function start(): Promise<void> {
    stopping = false;

    for (const def of definitions.values()) {
        await jobRepo.upsertJobRow(def.name, def.intervalSeconds, true);
    }

    logger.info(
        { jobs: Array.from(definitions.keys()) },
        "Job runner started"
    );

    intervalHandle = setInterval(() => tick(), 1000);
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
    if (stopping) return;

    let dueJobs: jobRepo.JobRow[];
    try {
        dueJobs = await jobRepo.findDueJobs();
    } catch (err) {
        logger.error({ err }, "Failed to query due jobs");
        return;
    }

    for (const row of dueJobs) {
        const def = definitions.get(row.job_name);
        if (!def) continue;
        if (stopping) break;

        const promise = runJob(def);
        inflightJobs.add(promise);
        promise.finally(() => inflightJobs.delete(promise));
    }
}

async function runJob(def: JobDefinition): Promise<void> {
    const client = await pool.connect();
    try {
        const lockResult = await client.query<{ pg_try_advisory_lock: boolean }>(
            `SELECT pg_try_advisory_lock(hashtext($1))`,
            [def.name]
        );
        if (!lockResult.rows[0]?.pg_try_advisory_lock) {
            jobLockContentionTotal.inc({ job: def.name });
            logger.debug({ job: def.name }, "Lock contention, skipping");
            return;
        }

        await jobRepo.markStarted(def.name);

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
            await jobRepo.markFinished(def.name, "SUCCESS");
            ctx.logger.info({ durationMs: Math.round(durationMs) }, "Job completed");
        } catch (err) {
            const durationMs = performance.now() - startMs;
            const errMsg = err instanceof Error ? err.message : String(err);
            jobRunsTotal.inc({ job: def.name, status: "failed" });
            jobDurationMs.observe({ job: def.name }, durationMs);
            await jobRepo.markFinished(def.name, "FAILED", errMsg);
            ctx.logger.error({ err, durationMs: Math.round(durationMs) }, "Job failed");
        } finally {
            clearTimeout(timer);
        }
    } finally {
        client.release();
    }
}

export async function triggerJob(name: string): Promise<{ status: string; error?: string }> {
    const def = definitions.get(name);
    if (!def) return { status: "NOT_FOUND", error: `Unknown job: ${name}` };

    await runJob(def);

    const row = await jobRepo.getJobRow(name);
    return {
        status: row?.last_status ?? "UNKNOWN",
        error: row?.last_error ?? undefined,
    };
}
