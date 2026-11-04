-- Per-pair safety cap on one order's notional (USD). It replaces the
-- per-order liquidity rejection: size below it fills with slippage
-- (trading/marketFillPrice.ts). It exists to stop typos, so reduce-only orders,
-- liquidations and system users are exempt (phase6OrderService).
ALTER TABLE trading_pairs
    ADD COLUMN IF NOT EXISTS max_order_notional NUMERIC(20, 2) NOT NULL DEFAULT 5000000;

ALTER TABLE trading_pairs DROP CONSTRAINT IF EXISTS trading_pairs_max_order_notional_check;
ALTER TABLE trading_pairs ADD CONSTRAINT trading_pairs_max_order_notional_check CHECK (max_order_notional > 0);

UPDATE trading_pairs SET max_order_notional = 2000000 WHERE symbol = 'SOL/USD';
