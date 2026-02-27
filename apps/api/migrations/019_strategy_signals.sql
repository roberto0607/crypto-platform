-- Strategy signals emitted by bot runs
CREATE TABLE strategy_signals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        UUID NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
    ts            BIGINT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('ENTRY', 'EXIT', 'REGIME_CHANGE', 'SETUP_DETECTED', 'SETUP_INVALIDATED')),
    side          TEXT CHECK (side IN ('BUY', 'SELL')),
    confidence    NUMERIC(10, 4),
    payload_json  JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_strategy_signals_run_ts ON strategy_signals (run_id, ts DESC);
