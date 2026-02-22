--Phase 3: Assets, Wallets, and Ledger
CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    decimals INT NOT NULL DEFAULT 8,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT assets_symbol_unique UNIQUE (symbol)
);

-- One wallet per user per asset
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES assets(id),
    balance NUMERIC(28, 8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT wallets_user_asset_unique UNIQUE (user_id, asset_id)
);

CREATE INDEX idx_wallets_user_id ON wallets (user_id);
CREATE INDEX idx_wallets_asset_id ON wallets (asset_id);

-- Immutable ledger of all balance changes
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    entry_type TEXT NOT NULL,
    amount NUMERIC(28, 8) NOT NULL,
    balance_after NUMERIC (28, 8) NOT NULL,
    reference_id UUID NULL,
    reference_type TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entry_type_check CHECK (
        entry_type IN ('DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL',
                       'FEE', 'ADMIN_CREDIT', 'ADMIN_DEBIT')
    )
);

CREATE INDEX idx_ledger_wallet_id ON ledger_entries (wallet_id);
CREATE INDEX idx_ledger_created_at ON ledger_entries (created_at);

-- Reuse the existing set_updated_at() trigger function from 001_init.sql
CREATE TRIGGER wallets_set_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();