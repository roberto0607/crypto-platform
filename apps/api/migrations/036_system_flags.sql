-- Phase 10 PR6: System-wide flags + per-pair trading kill switch
CREATE TABLE system_flags (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_flags (key, value) VALUES
    ('TRADING_ENABLED_GLOBAL', '{"enabled": true}'),
    ('READ_ONLY_MODE', '{"enabled": false}');

-- Add trading_enabled to trading_pairs (per-pair kill switch)
ALTER TABLE trading_pairs
    ADD COLUMN trading_enabled BOOLEAN NOT NULL DEFAULT true;
