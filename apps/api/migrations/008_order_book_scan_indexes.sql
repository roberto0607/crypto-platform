-- PR1: Side-specific order book indexes for optimal scan performance
--
-- The original idx_orders_book index uses all-ASC column order which works
-- for SELL-side scanning (price ASC, time ASC) but not for BUY-side scanning
-- (price DESC, time ASC) — PostgreSQL cannot do a backward index scan when
-- sort directions are mixed across columns.
--
-- Replace with two side-specific partial indexes whose column order matches
-- the exact ORDER BY used during matching. Also narrower (one side per index).

DROP INDEX IF EXISTS idx_orders_book;

-- SELL book: scanned by BUY taker, cheapest first
CREATE INDEX idx_orders_book_sell
    ON orders (pair_id, limit_price ASC, created_at ASC)
    WHERE side = 'SELL' AND status IN ('OPEN', 'PARTIALLY_FILLED') AND type = 'LIMIT';

-- BUY book: scanned by SELL taker, most expensive first
CREATE INDEX idx_orders_book_buy
    ON orders (pair_id, limit_price DESC, created_at ASC)
    WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED') AND type = 'LIMIT';
