-- Migration 100: orders.reduce_only
--
-- A reduce-only order may only shrink the position it closes (leverage PR 6a
-- made MARKET closes and MARKET trigger fires reduce-only, checked under the
-- pair lock at placement). PR 7 extends it to the LIMIT orders STOP_LIMIT /
-- TAKE_PROFIT_LIMIT triggers place. Those may rest, so the flag has to live on
-- the order row:
--   - a fill that closes the position cancels the owner's resting reduce-only
--     orders on that side (cancel_reason 'position_closed');
--   - a resting one that is swept fills at most what's left of the position;
--     the rest is canceled (cancel_reason 'reduce_only_no_position').
-- So a resting TP/SL can never open or flip a position after a liquidation
-- or a manual close.
--
-- Every existing order is false (the default). A constant default is a
-- metadata-only change: no table rewrite.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reduce_only BOOLEAN NOT NULL DEFAULT false;

-- close_reason: why a trigger's order closes (TP / SL / TRAILING), the value
-- closed_trades.close_reason gets. A resting TP/SL limit that fills later as
-- a maker journals with it instead of MANUAL. NULL for every other order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS close_reason TEXT DEFAULT NULL;

-- No new index on orders: the close hook's lookup (a user's open reduce-only
-- orders on a pair) is served by idx_orders_pair_status (open orders on the
-- pair), and building one here would block order writes on a large table
-- (each migration runs in a transaction, so no CONCURRENTLY).
