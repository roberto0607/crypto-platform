-- ML signal history with outcome tracking
CREATE TABLE ml_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    timeframe TEXT NOT NULL,
    signal_type TEXT NOT NULL CHECK (signal_type IN ('BUY', 'SELL')),
    confidence NUMERIC(5,2) NOT NULL,
    entry_price NUMERIC(28,8) NOT NULL,
    tp1_price NUMERIC(28,8) NOT NULL,
    tp2_price NUMERIC(28,8) NOT NULL,
    tp3_price NUMERIC(28,8) NOT NULL,
    stop_loss_price NUMERIC(28,8) NOT NULL,
    tp1_prob NUMERIC(5,2),
    tp2_prob NUMERIC(5,2),
    tp3_prob NUMERIC(5,2),
    regime TEXT,
    model_version TEXT NOT NULL,
    top_features JSONB,
    -- Outcome tracking (filled by signal tracker job)
    tp1_hit_at TIMESTAMPTZ,
    tp2_hit_at TIMESTAMPTZ,
    tp3_hit_at TIMESTAMPTZ,
    sl_hit_at TIMESTAMPTZ,
    outcome TEXT DEFAULT 'pending' CHECK (outcome IN ('pending','tp1','tp2','tp3','sl','expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ
);

CREATE INDEX idx_ml_signals_pair ON ml_signals (pair_id, timeframe, created_at DESC);
CREATE INDEX idx_ml_signals_pending ON ml_signals (outcome) WHERE outcome = 'pending';

-- Model version registry
CREATE TABLE ml_model_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name TEXT NOT NULL,
    version TEXT NOT NULL UNIQUE,
    metrics JSONB NOT NULL,
    is_active BOOLEAN DEFAULT false,
    trained_at TIMESTAMPTZ NOT NULL,
    training_samples INT,
    feature_importance JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
