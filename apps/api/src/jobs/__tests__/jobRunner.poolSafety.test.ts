/**
 * jobRunner.poolSafety.test.ts — the job runner must never deadlock the pg
 * pool or leak its advisory locks.
 *
 * Regression for the 2026-10-01 finding: runJob held a pooled client (for its
 * session-level advisory lock) for the whole job while markStarted /
 * markFinished / the job body needed a second client from the same pool. With
 * N due jobs >= pool size, every client was held by a runJob waiting for one
 * more — a permanent freeze (locally: 20 jobs vs DB_POOL_MAX 20, 24k waiters).
 * In prod, 18 jobs come due together after >=1h of API downtime, against 18
 * usable clients (20 minus 2 leader-election locks).
 *
 * Integration-style against the real test Postgres, but with a 7-client pool
 * so "more due jobs than clients" is cheap to set up. job_runs is truncated
 * per test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import pg from "pg";

const { SMALL_POOL_MAX } = vi.hoisted(() => ({ SMALL_POOL_MAX: 7 }));

vi.mock("../../db/pool", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../db/pool")>();
    const { Pool } = await import("pg");
    return {
        ...actual,
        pool: new Pool({ connectionString: process.env.DATABASE_URL, max: SMALL_POOL_MAX }),
    };
});

import { pool } from "../../db/pool";
import { ensureMigrations } from "../../testing/resetDb";
import { registerJobs, start, stop, triggerJob, safeMaxConcurrency, __resetJobRunnerForTest } from "../jobRunner";
import type { JobDefinition } from "../jobTypes";

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Never let a regression hang the suite: stop() awaits in-flight jobs. */
async function stopWithin(ms: number) {
    await Promise.race([stop(), sleep(ms)]);
}

async function makeAllDue() {
    await pool.query(`UPDATE job_runs SET next_run_at = now() - interval '1 second'`);
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await pred()) return true;
        await sleep(100);
    }
    return false;
}

async function statuses(prefix: string): Promise<Record<string, string | null>> {
    const r = await pool.query<{ job_name: string; last_status: string | null }>(
        `SELECT job_name, last_status FROM job_runs WHERE job_name LIKE $1 ORDER BY job_name`,
        [`${prefix}%`],
    );
    return Object.fromEntries(r.rows.map((x) => [x.job_name, x.last_status]));
}

function job(name: string, run: JobDefinition["run"]): JobDefinition {
    return { name, intervalSeconds: 3600, run };
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    __resetJobRunnerForTest();
    await pool.query("TRUNCATE job_runs");
});

afterEach(async () => {
    await stopWithin(3_000);
});

afterAll(async () => {
    await Promise.race([pool.end(), sleep(2_000)]);
});

describe("safeMaxConcurrency", () => {
    it("leaves the leader reserve plus a free client per in-flight job", () => {
        expect(safeMaxConcurrency(20)).toBe(8); // prod default DB_POOL_MAX
        expect(safeMaxConcurrency(40)).toBe(18); // prod stopgap DB_POOL_MAX
        expect(safeMaxConcurrency(7)).toBe(2);
        expect(safeMaxConcurrency(3)).toBe(1); // never below 1
    });
});

describe("jobRunner — pool safety", () => {
    it("runs more due jobs than the pool has clients without deadlocking", async () => {
        const N = SMALL_POOL_MAX * 2;
        registerJobs(
            Array.from({ length: N }, (_, i) =>
                job(`pooltest-${i}`, async (ctx) => {
                    // The job body itself also needs a client, like real jobs do.
                    await ctx.pool.query("SELECT pg_sleep(0.05)");
                }),
            ),
        );
        await start();
        await makeAllDue();

        const allDone = await waitFor(async () => {
            const s = await Promise.race([statuses("pooltest-"), sleep(500).then(() => null)]);
            return !!s && Object.keys(s).length === N && Object.values(s).every((v) => v === "SUCCESS");
        }, 10_000);
        expect(allDone).toBe(true);
        expect(pool.waitingCount).toBe(0);
    });

    it("releases the advisory lock after each run", async () => {
        registerJobs([job("locktest", async () => {})]);
        await start();
        await makeAllDue();
        expect(await waitFor(async () => (await statuses("locktest"))["locktest"] === "SUCCESS", 5_000)).toBe(true);

        // A different session must be able to take the job's lock now. Before the
        // fix the pooled session kept it, so the next run (on another pooled
        // client) was silently skipped as "lock contention".
        const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await other.connect();
        try {
            const r = await other.query<{ ok: boolean }>(
                "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
                ["locktest"],
            );
            expect(r.rows[0]!.ok).toBe(true);
            await other.query("SELECT pg_advisory_unlock(hashtext($1))", ["locktest"]);
        } finally {
            await other.end();
        }
    });

    it("caps concurrent jobs and never starts a job that is already in flight", async () => {
        let running = 0;
        let maxRunning = 0;
        const runs = new Map<string, number>();
        registerJobs(
            Array.from({ length: 5 }, (_, i) =>
                job(`captest-${i}`, async () => {
                    runs.set(`captest-${i}`, (runs.get(`captest-${i}`) ?? 0) + 1);
                    running++;
                    maxRunning = Math.max(maxRunning, running);
                    // Longer than the 1s tick, so later ticks still see the job as due/in flight.
                    await sleep(1_500);
                    running--;
                }),
            ),
        );
        await start({ maxConcurrency: 2 });
        await makeAllDue();

        const allDone = await waitFor(async () => {
            const s = await statuses("captest-");
            return Object.keys(s).length === 5 && Object.values(s).every((v) => v === "SUCCESS");
        }, 15_000);
        expect(allDone).toBe(true);
        expect(maxRunning).toBeLessThanOrEqual(2);
        expect([...runs.values()]).toEqual([1, 1, 1, 1, 1]);
    });

    it("skips a run instead of hanging when no client frees up in time, then recovers", async () => {
        registerJobs([job("starvetest", async () => {})]);
        await start({ acquireTimeoutMs: 300 });

        // Starve the pool completely, then ask for a run.
        const held = await Promise.all(Array.from({ length: SMALL_POOL_MAX }, () => pool.connect()));
        try {
            const t0 = Date.now();
            const res = await triggerJob("starvetest");
            expect(res.status).toBe("SKIPPED");
            expect(Date.now() - t0).toBeLessThan(2_000);
            const r = await held[0]!.query<{ last_status: string | null }>(
                `SELECT last_status FROM job_runs WHERE job_name = 'starvetest'`,
            );
            expect(r.rows[0]!.last_status).toBeNull(); // never claimed, nothing wedged in RUNNING
        } finally {
            held.forEach((c) => c.release());
        }

        expect((await triggerJob("starvetest")).status).toBe("SUCCESS");
    });

    it("manual trigger reports ALREADY_RUNNING for an in-flight job instead of running it twice", async () => {
        let calls = 0;
        registerJobs([
            job("triggertest", async () => {
                calls++;
                await sleep(800);
            }),
        ]);
        await start();
        const first = triggerJob("triggertest");
        await sleep(100);
        const second = await triggerJob("triggertest");
        expect(second.status).toBe("ALREADY_RUNNING");
        expect((await first).status).toBe("SUCCESS");
        expect(calls).toBe(1);
    });
});
