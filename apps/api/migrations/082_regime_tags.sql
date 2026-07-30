-- ============================================================
-- 082_regime_tags.sql
-- Market regime classification tags.
-- ============================================================
--
-- Context:
--   A simple time series of "what regime is this pair in right now"
--   classifications, for agents (and their explainability fields, see
--   trade_proposals.regime) to reference. No classifier logic ships in
--   this gate — this table just exists for one to write to later.
-- ============================================================

CREATE TABLE regime_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    regime TEXT NOT NULL,
    confidence NUMERIC(5,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports "latest regime for this pair" and history lookback.
CREATE INDEX idx_regime_tags_pair
    ON regime_tags (pair_id, created_at DESC);
