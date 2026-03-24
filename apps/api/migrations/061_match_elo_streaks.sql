-- Add win/loss tracking columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS win_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS loss_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS win_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS loss_streak INTEGER NOT NULL DEFAULT 0;

-- Add idempotency flag to matches so ELO resolution cannot double-apply
ALTER TABLE matches ADD COLUMN IF NOT EXISTS elo_resolved BOOLEAN NOT NULL DEFAULT false;

-- Add streak badge types to user_badges (reuse existing table from migration 047)
-- badge_type currently only allows 'WEEKLY_CHAMPION'; expand the CHECK or remove it
-- (the table uses TEXT so it's flexible — we just insert new types)
-- STREAK_3, STREAK_5, STREAK_10 badges

-- Store per-match ELO result details for the result endpoint
CREATE TABLE IF NOT EXISTS match_elo_results (
    match_id UUID PRIMARY KEY REFERENCES matches(id),
    winner_id UUID NOT NULL REFERENCES users(id),
    loser_id UUID NOT NULL REFERENCES users(id),
    winner_old_elo INTEGER NOT NULL,
    winner_new_elo INTEGER NOT NULL,
    winner_delta INTEGER NOT NULL,
    loser_old_elo INTEGER NOT NULL,
    loser_new_elo INTEGER NOT NULL,
    loser_delta INTEGER NOT NULL,
    winner_tier_before TEXT NOT NULL,
    winner_tier_after TEXT NOT NULL,
    loser_tier_before TEXT NOT NULL,
    loser_tier_after TEXT NOT NULL,
    winner_win_streak INTEGER NOT NULL DEFAULT 0,
    loser_loss_streak INTEGER NOT NULL DEFAULT 0,
    streak_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    badges_earned JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
