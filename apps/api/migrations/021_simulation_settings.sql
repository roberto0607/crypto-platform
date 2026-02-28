-- 021_simulation_settings.sql
-- Market microstructure simulation configuration

CREATE TABLE simulation_settings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    pair_id     UUID REFERENCES trading_pairs(id) ON DELETE CASCADE,
    config_json JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sim_settings_user_pair UNIQUE (user_id, pair_id)
);

CREATE INDEX idx_sim_settings_global
    ON simulation_settings (pair_id)
    WHERE user_id IS NULL;

CREATE INDEX idx_sim_settings_user
    ON simulation_settings (user_id)
    WHERE pair_id IS NULL;

-- Seed default global config (null, null)
INSERT INTO simulation_settings (user_id, pair_id, config_json)
VALUES (
    NULL,
    NULL,
    '{
        "base_spread_bps": 5,
        "base_slippage_bps": 2,
        "impact_bps_per_10k_quote": 10,
        "liquidity_quote_per_tick": 50000,
        "volatility_widening_k": 0.5
    }'::jsonb
);
