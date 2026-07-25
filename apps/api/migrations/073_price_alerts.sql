-- 073_price_alerts.sql  —  Price alerts (Gate 2)
--
-- Modeled on trigger_orders (017_trigger_orders.sql / 064_trailing_stop.sql):
-- same ID/timestamps/status conventions, same (pair_id, status) and
-- (user_id, status) index shape. condition_type is CROSSING-only (no plain
-- PRICE type — "crossing" fires either direction, resolving the ambiguity
-- without a side column). status uses CANCELLED (double-L), matching
-- trigger_orders' spelling exactly.

CREATE TABLE alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id),
  pair_id           UUID NOT NULL REFERENCES trading_pairs(id),
  condition_type    TEXT NOT NULL CHECK (condition_type IN (
                      'CROSSING', 'CROSSING_UP', 'CROSSING_DOWN'
                    )),
  target_value      NUMERIC(28,8) NOT NULL,
  frequency         TEXT NOT NULL CHECK (frequency IN ('ONCE', 'EVERY_N_MINUTES')),
  frequency_minutes INTEGER CHECK (frequency_minutes IS NULL OR frequency_minutes > 0),
  last_fired_at     TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
                      'ACTIVE', 'FIRED', 'EXPIRED', 'CANCELLED'
                    )),
  expiration        TIMESTAMPTZ,
  message_template  TEXT,
  channels          JSONB NOT NULL DEFAULT '["email"]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Named explicitly (not left to auto-naming) because the column-level
  -- CHECK on frequency_minutes above would otherwise collide: Postgres
  -- auto-names unnamed column CHECKs "<table>_<column>_check", which for an
  -- unnamed constraint here would also resolve to alerts_frequency_minutes_check.
  CONSTRAINT alerts_frequency_consistency_check CHECK (
    (frequency = 'EVERY_N_MINUTES' AND frequency_minutes IS NOT NULL) OR
    (frequency = 'ONCE' AND frequency_minutes IS NULL)
  )
);

CREATE INDEX idx_alerts_pair_status ON alerts (pair_id, status);
CREATE INDEX idx_alerts_user_status ON alerts (user_id, status);

CREATE TRIGGER trg_alerts_updated
  BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
