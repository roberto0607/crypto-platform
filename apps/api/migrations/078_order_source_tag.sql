-- ============================================================
-- 078_order_source_tag.sql
-- Provenance tag on orders: distinguish agent-originated from manual.
-- ============================================================
--
-- Context:
--   No existing column on `orders` distinguishes who/what placed an
--   order. Gate 1a's kill switch (AGENT_ACTIONS_ENABLED, migration 077)
--   must only ever gate agent-originated orders, never manual user
--   trading, so it needs a reliable per-row marker to check against.
--
-- What this migration does:
--   Adds a nullable `source` column, following the exact same bolt-on
--   pattern migration 066 used for match_id: ALTER TABLE ADD COLUMN,
--   default/existing rows unaffected. NULL (the default) means "manual
--   user order" — zero behavior change for every existing order and
--   every caller that doesn't pass a source. A non-null value tags the
--   order's origin; 'agent' is the only value written by application
--   code today, but this is left as free TEXT (not a CHECK-constrained
--   enum) since more origins (e.g. per-agent-name granularity) are
--   likely once Gate 1b's agents exist.
--
-- Paired code changes (same PR):
--   - trading/orderRepo.ts          : createOrder() accepts source
--   - trading/matchingEngine.ts     : threads source through placeOrderTx
--   - trading/phase6OrderService.ts : placeOrderWithSnapshot accepts source,
--                                     enforces AGENT_ACTIONS_ENABLED when
--                                     source = 'agent'
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_source
    ON orders (source)
    WHERE source IS NOT NULL;
