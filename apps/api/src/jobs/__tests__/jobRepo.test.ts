/**
 * jobRepo.test.ts — stale-RUNNING recovery for the background job runner.
 *
 * Integration-style: hits the real Postgres at DATABASE_URL via the pool
 * singleton (mirrors matchCleanupJob.test.ts / walletRepo.test.ts). These
 * assertions are the SQL predicates that fix the wedge — findDueJobs's
 * stale-RUNNING escape hatch, markStarted's defensive (ms-precision) claim,
 * and resetStaleRunningOnStartup — and a mock can't exercise interval
 * arithmetic, COALESCE, IS [NOT] DISTINCT FROM, or the driver's
 * timestamptz→Date round-trip. job_runs is truncated per-test for isolation.
 *
 * Regression coverage for:
 *   docs/designs/2026-05-29-job-runner-stale-running-recovery.md
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { ensureMigrations } from "../../testing/resetDb";
import * as jobRepo from "../jobRepo";

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    // Clean slate so Test 4's global RUNNING count is deterministic and the
    // findDueJobs assertions see only the row under test.
    await pool.query("TRUNCATE job_runs");
});

describe("jobRepo — stale-RUNNING recovery", () => {
    it("Test 1: findDueJobs reclaims a row stuck in RUNNING past its staleness threshold", async () => {
        // max_run_seconds=30; started 40s ago → 10s past the ceiling.
        await pool.query(
            `INSERT INTO job_runs
                 (job_name, is_enabled, interval_seconds, max_run_seconds, last_status, last_started_at, next_run_at)
             VALUES ('test-stale', true, 10, 30, 'RUNNING', now() - interval '40 seconds', now() - interval '1 second')`,
        );

        const due = await jobRepo.findDueJobs();
        expect(due.map((r) => r.job_name)).toContain("test-stale");
    });

    it("Test 2: findDueJobs does NOT reclaim a row in RUNNING within its staleness threshold", async () => {
        // Same row but started only 5s ago → well within the 30s ceiling.
        // Safety net: proves we recover crashed runs without pre-empting live ones.
        await pool.query(
            `INSERT INTO job_runs
                 (job_name, is_enabled, interval_seconds, max_run_seconds, last_status, last_started_at, next_run_at)
             VALUES ('test-fresh', true, 10, 30, 'RUNNING', now() - interval '5 seconds', now() - interval '1 second')`,
        );

        const due = await jobRepo.findDueJobs();
        expect(due.map((r) => r.job_name)).not.toContain("test-fresh");
    });

    it("Test 3: markStarted bails when row was claimed by another worker between selection and start", async () => {
        await pool.query(
            `INSERT INTO job_runs
                 (job_name, is_enabled, interval_seconds, last_status, last_started_at, next_run_at)
             VALUES ('test-race', true, 10, 'SUCCESS', now() - interval '100 seconds', now() - interval '1 second')`,
        );

        // Our worker's view at selection time.
        const selected = await jobRepo.getJobRow("test-race");
        const observedStartedAt = selected!.last_started_at;

        // Another worker claims it first: advances last_started_at and flips to RUNNING.
        await pool.query(
            `UPDATE job_runs SET last_started_at = now(), last_status = 'RUNNING' WHERE job_name = 'test-race'`,
        );

        // Our claim, using the now-stale observed timestamp, must bail.
        const claimed = await jobRepo.markStarted("test-race", observedStartedAt);
        expect(claimed).toBeNull();
    });

    it("Test 3b: findDueJobs → markStarted round-trip reclaims a stale RUNNING row (driver Date precision)", async () => {
        // The realistic reclaim path: read the stale row through findDueJobs (so
        // last_started_at is the ms-truncated JS Date the driver returns), then
        // pass it straight to markStarted exactly as runJob does. The claim must
        // succeed — it fails if markStarted compares at microsecond precision.
        await pool.query(
            `INSERT INTO job_runs
                 (job_name, is_enabled, interval_seconds, max_run_seconds, last_status, last_started_at, next_run_at)
             VALUES ('test-reclaim', true, 10, 30, 'RUNNING', now() - interval '40 seconds', now() - interval '1 second')`,
        );

        const due = await jobRepo.findDueJobs();
        const row = due.find((r) => r.job_name === "test-reclaim");
        expect(row).toBeDefined();

        const claimed = await jobRepo.markStarted("test-reclaim", row!.last_started_at);
        expect(claimed).not.toBeNull();
    });

    it("Test 4: resetStaleRunningOnStartup flips RUNNING → FAILED with last_error; leaves non-RUNNING unchanged", async () => {
        await pool.query(
            `INSERT INTO job_runs
                 (job_name, is_enabled, interval_seconds, last_status, last_started_at)
             VALUES
                 ('test-was-running', true, 10, 'RUNNING', now() - interval '5 seconds'),
                 ('test-was-success', true, 10, 'SUCCESS', now() - interval '5 seconds')`,
        );

        const count = await jobRepo.resetStaleRunningOnStartup();
        expect(count).toBe(1);

        const wasRunning = await jobRepo.getJobRow("test-was-running");
        const wasSuccess = await jobRepo.getJobRow("test-was-success");
        expect(wasRunning!.last_status).toBe("FAILED");
        expect(wasRunning!.last_error).toBe("reset on startup (was RUNNING)");
        expect(wasSuccess!.last_status).toBe("SUCCESS");
        expect(wasSuccess!.last_error).toBeNull();
    });
});
