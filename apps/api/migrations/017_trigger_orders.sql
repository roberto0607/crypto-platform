-- 017_trigger_orders.sql  —  Trigger orders for advanced order types

CREATE TABLE trigger_orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  pair_id        UUID NOT NULL REFERENCES trading_pairs(id),
  kind           TEXT NOT NULL CHECK (kind IN (
                   'STOP_MARKET','STOP_LIMIT','TAKE_PROFIT_MARKET','TAKE_PROFIT_LIMIT'
                 )),
  side           TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  trigger_price  NUMERIC(28,8) NOT NULL,
  limit_price    NUMERIC(28,8),
  qty            NUMERIC(28,8) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
                   'ACTIVE','TRIGGERED','CANCELED','EXPIRED','FAILED'
                 )),
  oco_group_id   UUID,
  derived_order_id UUID,
  fail_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_trigger_orders_pair_status
  ON trigger_orders (pair_id, status);

CREATE INDEX idx_trigger_orders_user_status
  ON trigger_orders (user_id, status);

CREATE INDEX idx_trigger_orders_oco_group
  ON trigger_orders (oco_group_id)
  WHERE oco_group_id IS NOT NULL;

-- Reuse existing set_updated_at trigger function
CREATE TRIGGER trg_trigger_orders_updated
  BEFORE UPDATE ON trigger_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
