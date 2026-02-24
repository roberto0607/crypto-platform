-- Phase 4: Trading pairs (markets)
CREATE TABLE trading_pairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_asset_id UUID NOT NULL REFERENCES assets(id),
    quote_asset_id UUID NOT NULL REFERENCES assets(id),
    symbol TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_price NUMERIC(28, 8) NULL,
    fee_bps INT NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pairs_different_assets CHECK (base_asset_id <> quote_asset_id),
    CONSTRAINT pairs_symbol_unique UNIQUE (symbol),
    CONSTRAINT pairs_assets_unique UNIQUE (base_asset_id, quote_asset_id),
    CONSTRAINT pairs_fee_range CHECK (fee_bps >= 0 AND fee_bps <= 10000),
    CONSTRAINT pairs_last_price_positive CHECK (last_price IS NULL OR last_price > 0)
);

CREATE INDEX idx_pairs_active ON trading_pairs (is_active) WHERE is_active = true;

CREATE TRIGGER pairs_set_updated_at
    BEFORE UPDATE ON trading_pairs FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();