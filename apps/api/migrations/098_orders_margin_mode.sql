-- Migration 098: orders.margin_mode
--
-- An order remembers which model it was placed under, the way it already
-- remembers its leverage (096). A resting LIMIT can fill long after it was
-- placed, and its maker leg must settle the way it was reserved:
--   SPOT      reserved base (a SELL) or quote (a BUY); settles base + quote
--             wallets, exactly as before leverage.
--   ISOLATED  reserved USD margin + max fee for either side; settles into an
--             isolated position, never touching base.
-- Reading it from the order (not from LEVERAGE_ENABLED or the user's position
-- at fill time) keeps a flag flip from mis-settling a resting order.
--
-- Every existing order is SPOT (the default). NOT VALID for the same reason
-- as orders_leverage_check in 096: no scan of the large orders table under an
-- exclusive lock at deploy; new and updated rows are checked.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS margin_mode TEXT NOT NULL DEFAULT 'SPOT';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_margin_mode_check;
ALTER TABLE orders ADD CONSTRAINT orders_margin_mode_check
    CHECK (margin_mode IN ('SPOT', 'ISOLATED')) NOT VALID;
