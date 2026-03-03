-- Phase 10 PR3: Performance indexes for hot-path queries
-- Justified in docs/perf-investigation.md
--
-- NOTE: For production with large tables, recreate these with
-- CREATE INDEX CONCURRENTLY (outside a transaction).

-- 1. User order list: covers ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_orders_user_created
    ON orders (user_id, created_at DESC, id DESC);

-- 2. Ledger wallet history: covers ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_created
    ON ledger_entries (wallet_id, created_at DESC);

-- 3. Trade history by pair: covers ORDER BY executed_at DESC
CREATE INDEX IF NOT EXISTS idx_trades_pair_executed
    ON trades (pair_id, executed_at DESC);

-- 4. Ledger invariant check: covers WHERE reference_id = $1
CREATE INDEX IF NOT EXISTS idx_ledger_reference
    ON ledger_entries (reference_id)
    WHERE reference_id IS NOT NULL;
