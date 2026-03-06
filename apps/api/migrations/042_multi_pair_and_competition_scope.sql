-- Phase 14 PR1: Multi-pair assets + competition scoping columns

-- ═══ Part A: New assets and trading pairs ═══

INSERT INTO assets (id, symbol, name, decimals)
VALUES (gen_random_uuid(), 'ETH', 'Ethereum', 8)
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO assets (id, symbol, name, decimals)
VALUES (gen_random_uuid(), 'SOL', 'Solana', 8)
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO trading_pairs (id, base_asset_id, quote_asset_id, symbol, fee_bps, maker_fee_bps, taker_fee_bps)
SELECT gen_random_uuid(), e.id, u.id, 'ETH/USD', 10, 2, 5
FROM assets e, assets u
WHERE e.symbol = 'ETH' AND u.symbol = 'USD'
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO trading_pairs (id, base_asset_id, quote_asset_id, symbol, fee_bps, maker_fee_bps, taker_fee_bps)
SELECT gen_random_uuid(), s.id, u.id, 'SOL/USD', 10, 2, 5
FROM assets s, assets u
WHERE s.symbol = 'SOL' AND u.symbol = 'USD'
ON CONFLICT (symbol) DO NOTHING;

-- ═══ Part B: Competition scoping columns ═══

-- Wallets: NULL = free play, UUID = competition-scoped
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS competition_id UUID DEFAULT NULL;

-- Replace old unique constraint with one that supports competition scoping
-- COALESCE trick: NULL competition_id maps to the nil UUID for uniqueness
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_user_asset_unique;
CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_asset_comp_unique
    ON wallets(user_id, asset_id, COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'));

-- Orders: track which competition an order belongs to
ALTER TABLE orders ADD COLUMN IF NOT EXISTS competition_id UUID DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_competition ON orders(competition_id) WHERE competition_id IS NOT NULL;

-- Positions: scoped to competition
ALTER TABLE positions ADD COLUMN IF NOT EXISTS competition_id UUID DEFAULT NULL;

-- The existing PK is (user_id, pair_id). We need to include competition_id.
-- Drop old PK and recreate as unique index with COALESCE trick (same pattern as wallets).
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS positions_user_pair_comp_unique
    ON positions(user_id, pair_id, COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'));

-- Equity snapshots: scoped to competition
ALTER TABLE equity_snapshots ADD COLUMN IF NOT EXISTS competition_id UUID DEFAULT NULL;

-- The existing PK is (user_id, ts). We need to include competition_id.
ALTER TABLE equity_snapshots DROP CONSTRAINT IF EXISTS equity_snapshots_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS equity_snapshots_user_ts_comp_unique
    ON equity_snapshots(user_id, ts, COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'));

CREATE INDEX IF NOT EXISTS idx_equity_snapshots_comp
    ON equity_snapshots(competition_id) WHERE competition_id IS NOT NULL;

-- ═══ Part C: New ledger entry types for competitions ═══

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entry_type_check CHECK (
    entry_type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'FEE',
        'ADMIN_CREDIT', 'ADMIN_DEBIT',
        'COMPETITION_CREDIT', 'COMPETITION_RESET'
    )
);
