-- 024_rollups_and_retention.sql
-- Phase 9 PR3: Rollup tables for equity snapshots + retention job seed

-- 1-minute rollup of equity snapshots (last value per minute bucket)
CREATE TABLE equity_snapshots_1m (
    user_id              UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bucket_ts            BIGINT         NOT NULL,
    equity_quote         NUMERIC(28,8)  NOT NULL,
    cash_quote           NUMERIC(28,8),
    holdings_quote       NUMERIC(28,8),
    unrealized_pnl_quote NUMERIC(28,8),
    realized_pnl_quote   NUMERIC(28,8),
    fees_paid_quote      NUMERIC(28,8),
    PRIMARY KEY (user_id, bucket_ts)
);

CREATE INDEX idx_equity_1m_user_ts_desc
    ON equity_snapshots_1m (user_id, bucket_ts DESC);

-- 1-day rollup of equity snapshots (last value per calendar day UTC)
CREATE TABLE equity_snapshots_1d (
    user_id              UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bucket_date          DATE           NOT NULL,
    equity_quote         NUMERIC(28,8)  NOT NULL,
    cash_quote           NUMERIC(28,8),
    holdings_quote       NUMERIC(28,8),
    unrealized_pnl_quote NUMERIC(28,8),
    realized_pnl_quote   NUMERIC(28,8),
    fees_paid_quote      NUMERIC(28,8),
    PRIMARY KEY (user_id, bucket_date)
);

CREATE INDEX idx_equity_1d_user_date_desc
    ON equity_snapshots_1d (user_id, bucket_date DESC);

-- Seed retention job into job_runs
INSERT INTO job_runs (job_name, interval_seconds, is_enabled, next_run_at)
VALUES ('retention', 3600, true, now() + interval '3600 seconds')
ON CONFLICT (job_name) DO NOTHING;
