-- Phase 5 PR2: Replay session state per user per pair
CREATE TABLE replay_sessions (
    user_id UUID NOT NULL REFERENCES users(id),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    current_ts TIMESTAMPTZ NOT NULL,
    speed NUMERIC(4, 1) NOT NULL DEFAULT 1.0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_paused BOOLEAN NOT NULL DEFAULT false,
    timeframe TEXT NOT NULL DEFAULT '1m',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, pair_id),
    CONSTRAINT replay_speed_range CHECK (speed > 0 AND speed <=100),
    CONSTRAINT replay_timeframe_check CHECK (
        timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')
    )
);

CREATE TRIGGER replay_sessions_set_updated_at
    BEFORE UPDATE ON replay_sessions FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();