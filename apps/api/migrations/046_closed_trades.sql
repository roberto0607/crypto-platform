-- 046_closed_trades.sql  —  Materialized round-trip trade journal with FIFO P&L

CREATE TABLE closed_trades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair_id         UUID NOT NULL REFERENCES trading_pairs(id),
    competition_id  UUID DEFAULT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),

    -- Entry leg
    entry_fill_ids  UUID[] NOT NULL,          -- array of trade.id that formed the entry
    entry_qty       NUMERIC(28, 8) NOT NULL,
    entry_avg_price NUMERIC(28, 8) NOT NULL,  -- weighted average
    entry_fees      NUMERIC(28, 8) NOT NULL DEFAULT 0,
    entry_at        TIMESTAMPTZ NOT NULL,     -- timestamp of first entry fill

    -- Exit leg
    exit_fill_ids   UUID[] NOT NULL,          -- array of trade.id that formed the exit
    exit_qty        NUMERIC(28, 8) NOT NULL,
    exit_avg_price  NUMERIC(28, 8) NOT NULL,  -- weighted average
    exit_fees       NUMERIC(28, 8) NOT NULL DEFAULT 0,
    exit_at         TIMESTAMPTZ NOT NULL,     -- timestamp of last exit fill

    -- P&L
    gross_pnl       NUMERIC(28, 8) NOT NULL,  -- (exit - entry) * qty for LONG; inverse for SHORT
    total_fees      NUMERIC(28, 8) NOT NULL,  -- entry_fees + exit_fees
    net_pnl         NUMERIC(28, 8) NOT NULL,  -- gross_pnl - total_fees
    return_pct      NUMERIC(10, 4) NOT NULL,  -- net_pnl / (entry_avg_price * entry_qty) * 100
    holding_seconds INT NOT NULL,             -- exit_at - entry_at in seconds

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_closed_trades_user ON closed_trades(user_id, exit_at DESC);
CREATE INDEX idx_closed_trades_pair ON closed_trades(user_id, pair_id, exit_at DESC);
CREATE INDEX idx_closed_trades_comp ON closed_trades(competition_id, user_id)
    WHERE competition_id IS NOT NULL;
CREATE INDEX idx_closed_trades_pnl ON closed_trades(user_id, net_pnl);

-- Open lots: tracks the FIFO queue of unfilled entry quantities
CREATE TABLE open_lots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair_id     UUID NOT NULL REFERENCES trading_pairs(id),
    competition_id UUID DEFAULT NULL,
    fill_id     UUID NOT NULL,                -- references trades.id
    side        TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    price       NUMERIC(28, 8) NOT NULL,
    qty_total   NUMERIC(28, 8) NOT NULL,
    qty_remaining NUMERIC(28, 8) NOT NULL,    -- decremented as lots are consumed
    fee_quote   NUMERIC(28, 8) NOT NULL DEFAULT 0,
    filled_at   TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_open_lots_fifo ON open_lots(user_id, pair_id, competition_id, side, filled_at ASC)
    WHERE qty_remaining > 0;
