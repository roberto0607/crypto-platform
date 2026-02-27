-- Strategy bot runs
CREATE TABLE strategy_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id),
    pair_id       UUID NOT NULL REFERENCES trading_pairs(id),
    mode          TEXT NOT NULL CHECK (mode IN ('REPLAY', 'LIVE')),
    status        TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED', 'FAILED'))
                  DEFAULT 'RUNNING',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at    TIMESTAMPTZ,
    last_tick_ts  BIGINT,
    params_json   JSONB NOT NULL,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_strategy_runs_user_status ON strategy_runs (user_id, status);
CREATE INDEX idx_strategy_runs_pair_status ON strategy_runs (pair_id, status);

CREATE TRIGGER strategy_runs_set_updated_at
    BEFORE UPDATE ON strategy_runs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
