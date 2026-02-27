-- 016_risk_controls.sql
-- Phase 6 PR3: Risk limits + circuit breakers

-- ── risk_limits ──────────────────────────────────────────────
CREATE TABLE risk_limits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  pair_id       UUID REFERENCES trading_pairs(id) ON DELETE CASCADE,

  max_order_notional_quote  NUMERIC(28,8),
  max_position_base_qty     NUMERIC(28,8),
  max_open_orders_per_pair  INT,
  max_price_deviation_bps   INT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index using COALESCE to handle NULLs
-- '00000000-0000-0000-0000-000000000000' as sentinel for NULL
CREATE UNIQUE INDEX uq_risk_limits_scope
  ON risk_limits (
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(pair_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX idx_risk_limits_user ON risk_limits (user_id);

-- Trigger for updated_at
CREATE TRIGGER set_updated_at_risk_limits
  BEFORE UPDATE ON risk_limits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── circuit_breakers ────────────────────────────────────────
CREATE TABLE circuit_breakers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  breaker_key   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'CLOSED'
                  CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at     TIMESTAMPTZ,
  closes_at     TIMESTAMPTZ,
  reason        TEXT,
  metadata      JSONB DEFAULT '{}',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_circuit_breakers_status ON circuit_breakers (status)
  WHERE status = 'OPEN';

CREATE TRIGGER set_updated_at_circuit_breakers
  BEFORE UPDATE ON circuit_breakers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── seed global default risk limits ─────────────────────────
INSERT INTO risk_limits (user_id, pair_id,
  max_order_notional_quote, max_position_base_qty,
  max_open_orders_per_pair, max_price_deviation_bps)
VALUES (NULL, NULL,
  100000.00000000,
  1000.00000000,
  50,
  500
);
