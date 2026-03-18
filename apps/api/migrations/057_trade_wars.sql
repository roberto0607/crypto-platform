-- ============================================================
-- 057_trade_wars.sql
-- Trade Wars: rebuild competition system with ELO + 1v1 matches
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- A. WIPE ALL COMPETITION DATA (test data only)
-- ────────────────────────────────────────────────────────────

-- Clear FKs in transactional tables first (competition-scoped rows only)
-- trades references orders via buy_order_id/sell_order_id — delete trades first
DELETE FROM trades WHERE buy_order_id IN (SELECT id FROM orders WHERE competition_id IS NOT NULL)
                      OR sell_order_id IN (SELECT id FROM orders WHERE competition_id IS NOT NULL);
DELETE FROM equity_snapshots  WHERE competition_id IS NOT NULL;
DELETE FROM closed_trades     WHERE competition_id IS NOT NULL;
DELETE FROM open_lots         WHERE competition_id IS NOT NULL;
DELETE FROM orders            WHERE competition_id IS NOT NULL;
DELETE FROM positions         WHERE competition_id IS NOT NULL;
-- ledger_entries references wallets — delete entries for competition wallets first
DELETE FROM ledger_entries WHERE wallet_id IN (SELECT id FROM wallets WHERE competition_id IS NOT NULL);
DELETE FROM wallets           WHERE competition_id IS NOT NULL;

-- Delete competition-specific tables in FK-safe order (no CASCADE — prevents wiping wallets)
DELETE FROM competition_leaderboard;
DELETE FROM competition_participants;
DELETE FROM matches WHERE season_id IS NOT NULL;
DELETE FROM equity_snapshots WHERE competition_id IS NOT NULL;
DELETE FROM user_badges;
DELETE FROM user_tier_history;
DELETE FROM competitions;
TRUNCATE user_tiers;

-- ────────────────────────────────────────────────────────────
-- B. UPDATE TIER DEFAULT: ROOKIE stays, map old tiers on re-insert
--    (user_tiers was truncated, so just change the default)
-- ────────────────────────────────────────────────────────────

ALTER TABLE user_tiers
  ALTER COLUMN tier SET DEFAULT 'ROOKIE';

-- user_badges unique constraint references (tier, week_id) — still valid
-- No enum type used; tiers are plain text — new values enforced in app code

-- ────────────────────────────────────────────────────────────
-- C. ADD ELO RATING TO USERS
-- ────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN elo_rating INTEGER NOT NULL DEFAULT 800;

-- ────────────────────────────────────────────────────────────
-- D. ELO HISTORY TABLE
-- ────────────────────────────────────────────────────────────

CREATE TABLE elo_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  old_elo     INTEGER NOT NULL,
  new_elo     INTEGER NOT NULL,
  change_reason TEXT NOT NULL,  -- 'MATCH_WIN', 'MATCH_LOSS', 'MATCH_DRAW', 'SEASON_DECAY', 'PLACEMENT'
  match_id    UUID,             -- nullable: season decay has no match
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_elo_history_user ON elo_history(user_id);
CREATE INDEX idx_elo_history_match ON elo_history(match_id) WHERE match_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- E. MATCHES TABLE (1v1)
-- ────────────────────────────────────────────────────────────

CREATE TABLE matches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id               UUID REFERENCES competitions(id),  -- nullable for unranked matches
  challenger_id           UUID NOT NULL REFERENCES users(id),
  opponent_id             UUID NOT NULL REFERENCES users(id),
  status                  TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'COMPLETED', 'FORFEITED', 'EXPIRED')),
  duration_hours          INTEGER NOT NULL DEFAULT 24
    CHECK (duration_hours IN (24, 168, 336, 504, 672)),
  starting_capital        NUMERIC NOT NULL DEFAULT 50000,
  challenger_pnl_pct      NUMERIC,
  opponent_pnl_pct        NUMERIC,
  challenger_trades_count  INTEGER NOT NULL DEFAULT 0,
  opponent_trades_count    INTEGER NOT NULL DEFAULT 0,
  challenger_win_rate     NUMERIC,  -- % of profitable trades
  opponent_win_rate       NUMERIC,
  challenger_score        NUMERIC,  -- weighted composite score
  opponent_score          NUMERIC,
  winner_id               UUID REFERENCES users(id),
  forfeit_user_id         UUID REFERENCES users(id),
  elo_delta               INTEGER,  -- ELO points exchanged (stored for display)
  started_at              TIMESTAMPTZ,
  ends_at                 TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent duplicate active matches between same players
CREATE UNIQUE INDEX idx_matches_active_pair
  ON matches (LEAST(challenger_id, opponent_id), GREATEST(challenger_id, opponent_id))
  WHERE status IN ('PENDING', 'ACTIVE');

CREATE INDEX idx_matches_challenger ON matches(challenger_id);
CREATE INDEX idx_matches_opponent ON matches(opponent_id);
CREATE INDEX idx_matches_status ON matches(status) WHERE status IN ('PENDING', 'ACTIVE');
CREATE INDEX idx_matches_season ON matches(season_id) WHERE season_id IS NOT NULL;
CREATE INDEX idx_matches_ends_at ON matches(ends_at) WHERE status = 'ACTIVE';

-- FK for elo_history.match_id (now that matches table exists)
ALTER TABLE elo_history
  ADD CONSTRAINT elo_history_match_fk FOREIGN KEY (match_id) REFERENCES matches(id);

-- ────────────────────────────────────────────────────────────
-- F. MATCH POSITIONS (tracks positions during a match)
-- ────────────────────────────────────────────────────────────

CREATE TABLE match_positions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  pair_id     UUID NOT NULL REFERENCES trading_pairs(id),
  side        TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  entry_price NUMERIC NOT NULL,
  qty         NUMERIC NOT NULL,
  exit_price  NUMERIC,
  pnl         NUMERIC,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);

CREATE INDEX idx_match_positions_match ON match_positions(match_id);
CREATE INDEX idx_match_positions_user ON match_positions(match_id, user_id);

-- ────────────────────────────────────────────────────────────
-- G. MATCH ALLOWED PAIRS (both players locked to same pairs)
-- ────────────────────────────────────────────────────────────

CREATE TABLE match_allowed_pairs (
  match_id  UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  pair_id   UUID NOT NULL REFERENCES trading_pairs(id),
  PRIMARY KEY (match_id, pair_id)
);

-- ────────────────────────────────────────────────────────────
-- H. ADD NUANCED SCORE TO LEADERBOARD
-- ────────────────────────────────────────────────────────────

ALTER TABLE competition_leaderboard
  ADD COLUMN win_rate        NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN consistency     NUMERIC NOT NULL DEFAULT 0,  -- e.g. Sharpe or daily-return stdev inverse
  ADD COLUMN nuanced_score   NUMERIC NOT NULL DEFAULT 0;  -- weighted composite

-- ────────────────────────────────────────────────────────────
-- I. ADD STARTING CAPITAL + SEASON FIELDS TO COMPETITIONS
-- ────────────────────────────────────────────────────────────

-- starting_balance_usd already exists (default 100000) — keep it, it will hold per-tier values
-- Add season-specific columns

ALTER TABLE competitions
  ADD COLUMN season_number   INTEGER,          -- 1, 2, 3 ...
  ADD COLUMN off_season_ends TIMESTAMPTZ;      -- when the 3-day break ends (next season start)

-- Update competition_type check to include SEASON
-- (no CHECK constraint exists — it's plain text, enforced in app code)

-- Update unique index: old one is (tier, week_id) for WEEKLY type
-- Drop it and create a broader one for SEASON type
DROP INDEX IF EXISTS idx_competitions_weekly_tier_week;

CREATE UNIQUE INDEX idx_competitions_season_tier
  ON competitions (tier, season_number)
  WHERE competition_type = 'SEASON';

-- Keep the weekly index for backwards compat during transition
CREATE UNIQUE INDEX idx_competitions_weekly_tier_week
  ON competitions (tier, week_id)
  WHERE competition_type = 'WEEKLY';

-- ────────────────────────────────────────────────────────────
-- J. ADD BADGE TYPES FOR TRADE WARS
-- ────────────────────────────────────────────────────────────

-- Widen unique constraint on user_badges to support season-based badges
-- Old: (user_id, badge_type, week_id, tier)
-- New: (user_id, badge_type, tier, season_number) — but season_number is on competitions
-- For now, the existing unique constraint works (week_id can hold season identifiers)
-- No schema change needed — we'll use season identifiers in the week_id column

COMMIT;
