-- Allow negative wallet balances for paper-trading short positions.
-- A negative base balance (e.g. BTC = -0.001) represents a short position.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_balance_non_negative;

-- Remove balance >= reserved constraint (no longer valid with negative balances).
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_reserved_lte_balance;
