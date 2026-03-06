-- 040_login_attempts_job.sql — Register cleanup-login-attempts job

INSERT INTO job_runs (job_name, is_enabled, interval_seconds, next_run_at)
VALUES ('cleanup-login-attempts', true, 3600, now())
ON CONFLICT (job_name) DO NOTHING;
