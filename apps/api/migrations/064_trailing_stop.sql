-- Add trailing stop support to trigger_orders.
-- Existing triggers have NULL trailing columns = standard fixed behavior.

ALTER TABLE trigger_orders ADD COLUMN IF NOT EXISTS trailing_offset NUMERIC(20,8) NULL;
ALTER TABLE trigger_orders ADD COLUMN IF NOT EXISTS trailing_high_water_mark NUMERIC(20,8) NULL;

-- Widen the kind CHECK to include TRAILING_STOP_MARKET
ALTER TABLE trigger_orders DROP CONSTRAINT IF EXISTS trigger_orders_kind_check;
ALTER TABLE trigger_orders ADD CONSTRAINT trigger_orders_kind_check
    CHECK (kind = ANY (ARRAY[
        'STOP_MARKET', 'STOP_LIMIT',
        'TAKE_PROFIT_MARKET', 'TAKE_PROFIT_LIMIT',
        'TRAILING_STOP_MARKET'
    ]));
