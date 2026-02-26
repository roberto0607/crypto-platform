-- Phase 6 PR1: Positions table for tracking per-user per-pair holdings and PnL
CREATE TABLE positions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair_id UUID NOT NULL REFERENCES trading_pairs(id) ON DELETE CASCADE,
    base_qty NUMERIC(28, 8) NOT NULL DEFAULT 0,
    avg_entry_price NUMERIC(28, 8) NOT NULL DEFAULT 0,
    realized_pnl_quote NUMERIC(28, 8) NOT NULL DEFAULT 0,
    fees_paid_quote NUMERIC(28, 8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, pair_id)
);

CREATE TRIGGER positions_set_updated_at
    BEFORE UPDATE ON positions FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
