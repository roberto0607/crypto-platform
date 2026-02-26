-- Phase 6 PR1: Equity snapshots for portfolio value tracking over time
CREATE TABLE equity_snapshots (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts BIGINT NOT NULL,
    equity_quote NUMERIC(28, 8) NOT NULL,
    PRIMARY KEY (user_id, ts)
);

CREATE INDEX idx_equity_user_ts_desc
    ON equity_snapshots(user_id, ts DESC);
