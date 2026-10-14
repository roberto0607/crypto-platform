-- Migration 096: leverage foundation (schema only)
--
-- Real leverage (docs/designs/2026-10-13-leverage-design.md) makes every real
-- user's position perp-style with isolated margin. This migration only adds
-- the columns and tables that design needs. It is additive: every new column
-- has a default that describes today's behavior (SPOT, 1x, no margin), no
-- existing row is rewritten, and no code reads any of it until the
-- LEVERAGE_ENABLED work in later PRs.
--
-- Postgres 11+ adds a column with a constant default without rewriting the
-- table, so the ALTERs below are metadata-only.

-- ────────────────────────────────────────────────────────────
-- A. POSITIONS: the instrument
-- ────────────────────────────────────────────────────────────
-- margin_mode: SPOT = today's model (and, for good, the bots'); ISOLATED =
--   perp-style, margin held in the row, P&L settled in USD.
-- leverage: the position's leverage; an add must match it.
-- isolated_margin: the USD collateral locked in this position.
-- liq_price: NULL when flat or SPOT.
-- epoch: +1 each time the position opens from flat (or flips), so a
--   liquidation decided on one episode can't act on the next.
ALTER TABLE positions
    ADD COLUMN IF NOT EXISTS margin_mode     TEXT          NOT NULL DEFAULT 'SPOT',
    ADD COLUMN IF NOT EXISTS leverage        NUMERIC(6, 2) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS isolated_margin NUMERIC(28, 8) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS liq_price       NUMERIC(28, 8) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS epoch           INT           NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS opened_at       TIMESTAMPTZ   DEFAULT NULL;

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_margin_mode_check;
ALTER TABLE positions ADD CONSTRAINT positions_margin_mode_check
    CHECK (margin_mode IN ('SPOT', 'ISOLATED'));
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_leverage_check;
ALTER TABLE positions ADD CONSTRAINT positions_leverage_check CHECK (leverage >= 1);
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_isolated_margin_check;
ALTER TABLE positions ADD CONSTRAINT positions_isolated_margin_check CHECK (isolated_margin >= 0);
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_epoch_check;
ALTER TABLE positions ADD CONSTRAINT positions_epoch_check CHECK (epoch >= 0);

-- The liquidation engine's per-pair scans: longs from the highest liq price
-- down, shorts from the lowest up. Partial, so they hold only open isolated
-- positions (empty until leverage is enabled).
CREATE INDEX IF NOT EXISTS idx_positions_liq_long
    ON positions (pair_id, liq_price DESC)
    WHERE margin_mode = 'ISOLATED' AND base_qty > 0;
CREATE INDEX IF NOT EXISTS idx_positions_liq_short
    ON positions (pair_id, liq_price ASC)
    WHERE margin_mode = 'ISOLATED' AND base_qty < 0;

-- ────────────────────────────────────────────────────────────
-- B. TRADING_PAIRS: per-pair risk parameters
-- ────────────────────────────────────────────────────────────
-- maintenance_margin_bps: 50 = 0.5%. The approved SOL value (100) is set when
--   the engine starts reading this column, not here (no data rewrites).
-- max_leverage: the pair's own ceiling; the per-mode caps apply on top.
-- The pair check keeps the initial margin at max leverage above maintenance
-- margin, so no position can be liquidatable the moment it opens.
ALTER TABLE trading_pairs
    ADD COLUMN IF NOT EXISTS maintenance_margin_bps INT          NOT NULL DEFAULT 50,
    ADD COLUMN IF NOT EXISTS max_leverage           NUMERIC(6, 2) NOT NULL DEFAULT 10;

ALTER TABLE trading_pairs DROP CONSTRAINT IF EXISTS trading_pairs_margin_params_check;
ALTER TABLE trading_pairs ADD CONSTRAINT trading_pairs_margin_params_check CHECK (
    maintenance_margin_bps > 0
    AND max_leverage >= 1
    AND maintenance_margin_bps * max_leverage < 10000
);

-- ────────────────────────────────────────────────────────────
-- C. MATCHES: model + leverage cap, stamped at accept
-- ────────────────────────────────────────────────────────────
-- Every existing match (and every match until the engine stamps these) is a
-- SPOT match at 1x: exactly how it trades today.
ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS margin_mode  TEXT          NOT NULL DEFAULT 'SPOT',
    ADD COLUMN IF NOT EXISTS max_leverage NUMERIC(6, 2) NOT NULL DEFAULT 1;

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_margin_mode_check;
ALTER TABLE matches ADD CONSTRAINT matches_margin_mode_check
    CHECK (margin_mode IN ('SPOT', 'ISOLATED'));
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_max_leverage_check;
ALTER TABLE matches ADD CONSTRAINT matches_max_leverage_check CHECK (max_leverage >= 1);

-- ────────────────────────────────────────────────────────────
-- D. ORDERS: the leverage an order was placed at (a LIMIT may rest)
-- ────────────────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS leverage NUMERIC(6, 2) NOT NULL DEFAULT 1;

-- NOT VALID: orders is large (the market maker's ladders) and every existing
-- row has the default 1, so a validating scan under an exclusive lock at
-- deploy buys nothing. New and updated rows are checked as usual.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_leverage_check;
ALTER TABLE orders ADD CONSTRAINT orders_leverage_check CHECK (leverage >= 1) NOT VALID;

-- ────────────────────────────────────────────────────────────
-- E. LIQUIDATIONS: every liquidation, real or would-be
-- ────────────────────────────────────────────────────────────
-- LOG_ONLY: the engine's log-only mode recorded what it would have done.
-- EXECUTED: it closed the position. SKIPPED_STALE: a breach it didn't act on
-- because the pair's feed was stale.
CREATE TABLE IF NOT EXISTS liquidations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mode            TEXT NOT NULL CHECK (mode IN ('LOG_ONLY', 'EXECUTED', 'SKIPPED_STALE')),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair_id         UUID NOT NULL REFERENCES trading_pairs(id) ON DELETE CASCADE,
    competition_id  UUID DEFAULT NULL,
    match_id        UUID DEFAULT NULL REFERENCES matches(id) ON DELETE SET NULL,
    position_epoch  INT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
    qty             NUMERIC(28, 8) NOT NULL CHECK (qty > 0),
    entry_price     NUMERIC(28, 8) NOT NULL,
    leverage        NUMERIC(6, 2)  NOT NULL,
    margin          NUMERIC(28, 8) NOT NULL,
    liq_price       NUMERIC(28, 8) NOT NULL,
    -- The mark that tripped it, and the touch it closed at (NULL unless EXECUTED).
    mark_price      NUMERIC(28, 8) NOT NULL,
    fill_price      NUMERIC(28, 8) DEFAULT NULL,
    realized_pnl    NUMERIC(28, 8) DEFAULT NULL,
    fee             NUMERIC(28, 8) DEFAULT NULL,
    returned_equity NUMERIC(28, 8) DEFAULT NULL,
    -- Loss beyond the margin (a price gap), absorbed: never charged to the user.
    shortfall       NUMERIC(28, 8) NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
    book_age_ms     INT DEFAULT NULL,
    order_id        UUID DEFAULT NULL REFERENCES orders(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per position episode per mode, so log-only doesn't write a row per tick.
CREATE UNIQUE INDEX IF NOT EXISTS liquidations_once
    ON liquidations (
        user_id,
        pair_id,
        COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(match_id,       '00000000-0000-0000-0000-000000000000'::uuid),
        position_epoch,
        mode
    );

CREATE INDEX IF NOT EXISTS idx_liquidations_user ON liquidations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_liquidations_match ON liquidations (match_id) WHERE match_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- F. LEDGER: margin moves and the loss cap
-- ────────────────────────────────────────────────────────────
-- Same list as 095 plus five types. NOT VALID: every existing row already
-- passed the narrower 095 constraint, and skipping the re-check keeps this
-- from scanning the whole ledger under an exclusive lock at deploy. New and
-- updated rows are checked as usual.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entry_type_check CHECK (
    entry_type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRADE_BUY', 'TRADE_SELL', 'FEE',
        'ADMIN_CREDIT', 'ADMIN_DEBIT',
        'COMPETITION_CREDIT', 'COMPETITION_RESET',
        'FREE_PLAY_CREDIT',
        'FEE_CORRECTION',
        'MATCH_FUNDING', 'MATCH_SETTLEMENT',
        'MARGIN_LOCK', 'MARGIN_RELEASE', 'REALIZED_PNL',
        'LIQUIDATION_SHORTFALL', 'POSITION_CONVERSION'
    )
) NOT VALID;

-- ────────────────────────────────────────────────────────────
-- G. CLOSED_TRADES (journal): leverage, margin, why it closed
-- ────────────────────────────────────────────────────────────
-- close_reason stays NULL for every trade closed before the journal sets it.
-- match_id: the journal's lots aren't match-scoped yet (see
-- phase6OrderService); the column lets PR 7 record it.
ALTER TABLE closed_trades
    ADD COLUMN IF NOT EXISTS leverage             NUMERIC(6, 2)  NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS margin               NUMERIC(28, 8) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS close_reason         TEXT           DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS return_on_margin_pct NUMERIC(10, 4) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS match_id             UUID           DEFAULT NULL;

ALTER TABLE closed_trades DROP CONSTRAINT IF EXISTS closed_trades_close_reason_check;
ALTER TABLE closed_trades ADD CONSTRAINT closed_trades_close_reason_check CHECK (
    close_reason IS NULL
    OR close_reason IN ('MANUAL', 'TP', 'SL', 'TRAILING', 'LIQUIDATION', 'MATCH_END')
) NOT VALID; -- every existing row is NULL; no scan needed (same reason as orders)

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'closed_trades_match_fk'
          AND conrelid = 'closed_trades'::regclass
    ) THEN
        ALTER TABLE closed_trades
            ADD CONSTRAINT closed_trades_match_fk
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
    END IF;
END $$;
