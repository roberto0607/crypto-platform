-- Add forecast + regime detail columns to ml_signals
ALTER TABLE ml_signals
    ADD COLUMN regime_confidence NUMERIC(5,4),
    ADD COLUMN regime_strategy TEXT,
    ADD COLUMN forecast JSONB;
