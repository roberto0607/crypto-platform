-- Phase 4: Add reserved cloumn to wallets for order holds
ALTER TABLE wallets
    ADD COLUMN reserved NUMERIC(28, 8) NOT NULL DEFAULT 0;

ALTER TABLE wallets
    ADD CONSTRAINT wallets_reserved_non_negative CHECK (reserved >= 0);

ALTER TABLE wallets
    ADD CONSTRAINT wallets_reserved_lte_balance CHECK (balance >= reserved);