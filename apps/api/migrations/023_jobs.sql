-- 023_jobs.sql — Job runner state table

CREATE TABLE job_runs (
    job_name          TEXT PRIMARY KEY,
    is_enabled        BOOLEAN NOT NULL DEFAULT true,
    interval_seconds  INT NOT NULL,
    last_started_at   TIMESTAMPTZ,
    last_finished_at  TIMESTAMPTZ,
    last_status       TEXT,
    last_error        TEXT,
    next_run_at       TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at_job_runs
    BEFORE UPDATE ON job_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO job_runs (job_name, interval_seconds, is_enabled, next_run_at)
VALUES
    ('reconciliation',             300,   true,  now() + interval '300 seconds'),
    ('cleanup-refresh-tokens',     3600,  true,  now() + interval '3600 seconds'),
    ('cleanup-replay-sessions',    600,   true,  now() + interval '600 seconds'),
    ('cleanup-idempotency-keys',   86400, true,  now() + interval '86400 seconds'),
    ('portfolio-sampling',         300,   false, null)
ON CONFLICT (job_name) DO NOTHING;
