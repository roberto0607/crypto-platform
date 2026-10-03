/**
 * jobRunner.smallPool.test.ts — the job runner on a 3-client pool.
 *
 * A pool this small is the harshest case for the 2026-10-01 deadlock (runJob
 * held one client for its advisory lock, then needed a second for
 * bookkeeping): any 3 due jobs used to freeze it. Here 6 jobs come due at once
 * and must all finish; advisory locks must be released after a failed run as
 * well as a successful one; and a fully starved pool must make a run error
 * out (via the pool's connectionTimeoutMillis) instead of hanging.
 *
 * Integration-style against the real test Postgres; job_runs is truncated per
 * test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import pg from "pg";

const { POOL_MAX, ACQUIRE_TIMEOUT_MS } = vi.hoisted(() => ({ POOL_MAX: 3, ACQUIRE_TIMEOUT_MS: 1_000 }));

vi.mock("../../db/pool", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../db/pool")>();
    const { Pool } = await import("pg");
    return {
        ...actual,
        pool: new Pool({
            connectionString: process.env.DATABASE_URL,
            max: POOL_MAX,
            connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
        }),
    };
});

import { pool } from "../../db/pool";
import { ensureMigrations } from "../../testing/resetDb";
import { registerJobs, start, stop, triggerJob, __resetJobRunnerForTest } from "../jobRunner";
import type { JobDefinition } from "../jobTypes";

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
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

/** Whether a session outside the pool can take each job's advisory lock (i.e. nobody kept it). */
async function locksFree(names: string[]): Promise<boolean[]> {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
        const out: boolean[] = [];
        for (const name of names) {
            const r = await other.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [name]);
            out.push(r.rows[0]!.ok);
        }
        return out;
    } finally {
        await other.end(); // closing the session drops whatever it took
    }
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
    await Promise.race([stop(), sleep(3_000)]);
});

afterAll(async () => {
    await Promise.race([pool.end(), sleep(2_000)]);
});

describe("jobRunner — 3-client pool", () => {
    it("runs 6 jobs that come due at once without hanging", async () => {
        const N = 6;
        registerJobs(
            Array.from({ length: N }, (_, i) =>
                job(`smallpool-${i}`, async (ctx) => {
                    // The body needs its own client too, like real jobs.
                    await ctx.pool.query("SELECT pg_sleep(0.05)");
                }),
            ),
        );
        await start();
        await pool.query(`UPDATE job_runs SET next_run_at = now() - interval '1 second'`);

        const allDone = await waitFor(async () => {
            const s = await statuses("smallpool-");
            return Object.keys(s).length === N && Object.values(s).every((v) => v === "SUCCESS");
        }, 15_000);
        expect(allDone).toBe(true);
        expect(pool.waitingCount).toBe(0);
        expect(await locksFree(Array.from({ length: N }, (_, i) => `smallpool-${i}`))).toEqual(Array(N).fill(true));
    });

    it("releases the advisory lock after both a successful and a failed run", async () => {
        registerJobs([
            job("lockrel-ok", async (ctx) => {
                await ctx.pool.query("SELECT 1");
            }),
            job("lockrel-fail", async () => {
                throw new Error("boom");
            }),
        ]);
        await start();
        await pool.query(`UPDATE job_runs SET next_run_at = now() - interval '1 second'`);

        expect(
            await waitFor(async () => {
                const s = await statuses("lockrel-");
                return s["lockrel-ok"] === "SUCCESS" && s["lockrel-fail"] === "FAILED";
            }, 10_000),
        ).toBe(true);
        await stop(); // nothing in flight past this point

        expect(await locksFree(["lockrel-ok", "lockrel-fail"])).toEqual([true, true]);
        // And the runner can take them again itself (a leaked lock surfaced as "skipped").
        expect((await triggerJob("lockrel-ok")).status).toBe("SUCCESS");
        expect((await triggerJob("lockrel-fail")).status).toBe("FAILED");
    });

    it("errors out at the pool acquire timeout instead of hanging when the pool is starved, then recovers", async () => {
        registerJobs([job("starve", async () => {})]);
        await start();

        const held = await Promise.all(Array.from({ length: POOL_MAX }, () => pool.connect()));
        try {
            const t0 = Date.now();
            const res = await triggerJob("starve");
            expect(res.status).toBe("SKIPPED");
            expect(Date.now() - t0).toBeLessThan(ACQUIRE_TIMEOUT_MS + 2_000);
            const r = await held[0]!.query<{ last_status: string | null }>(
                `SELECT last_status FROM job_runs WHERE job_name = 'starve'`,
            );
            expect(r.rows[0]!.last_status).toBeNull(); // never claimed, nothing wedged in RUNNING
        } finally {
            held.forEach((c) => c.release());
        }

        expect((await triggerJob("starve")).status).toBe("SUCCESS");
    });
});
