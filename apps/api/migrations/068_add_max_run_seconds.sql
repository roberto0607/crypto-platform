-- Migration 068: Add job_runs.max_run_seconds (stale-RUNNING recovery)
--
-- Background: the market-maker job wedged in production for ~2 months
-- (last_status='RUNNING' from 2026-03-30 with last_started_at AFTER
-- last_finished_at — a run that began and never finished because the
-- process was killed mid-run). findDueJobs() excludes RUNNING rows with
-- no escape hatch, and upsertJobRow()'s ON CONFLICT never resets status,
-- so the row was skipped on every tick forever. See
-- docs/designs/2026-05-29-job-runner-stale-running-recovery.md.
--
-- This column gives each job a per-job staleness ceiling: a RUNNING row
-- whose last_started_at is older than max_run_seconds is considered
-- crashed and becomes eligible for reclaim by findDueJobs().
--
-- NULL means "use the app-code default" — LEAST(interval_seconds * 5, 300)
-- — computed in jobRepo at query time. The app still functions with the
-- column all-NULL; the backfill below is a one-time convenience that
-- materializes that same default for rows that exist today.

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS max_run_seconds INTEGER NULL;

-- One-time backfill of existing rows to the app-code default.
-- Idempotent: the WHERE guard skips rows already populated, so re-running
-- this migration is a no-op for any row that has a value.
UPDATE job_runs
SET max_run_seconds = LEAST(interval_seconds * 5, 300)
WHERE max_run_seconds IS NULL;
