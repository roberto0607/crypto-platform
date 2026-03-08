-- Phase 18 PR1: Weekly competition tier system, badges, and auto-creation support

-- ═══ 1. Extend competitions table for weekly auto-creation ═══

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS competition_type TEXT
    NOT NULL DEFAULT 'CUSTOM'
    CHECK (competition_type IN ('CUSTOM', 'WEEKLY'));

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT NULL
    CHECK (tier IN ('ROOKIE','TRADER','SPECIALIST','EXPERT','MASTER','LEGEND'));

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS week_id TEXT DEFAULT NULL;

ALTER TABLE competitions ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS tier_adjustments_processed BOOLEAN
    NOT NULL DEFAULT false;

-- Only one weekly competition per tier per week
CREATE UNIQUE INDEX IF NOT EXISTS idx_competitions_weekly_tier_week
    ON competitions(tier, week_id) WHERE competition_type = 'WEEKLY';

CREATE INDEX IF NOT EXISTS idx_competitions_type ON competitions(competition_type);

-- ═══ 2. User tiers ═══

CREATE TABLE IF NOT EXISTS user_tiers (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tier TEXT NOT NULL DEFAULT 'ROOKIE'
        CHECK (tier IN ('ROOKIE','TRADER','SPECIALIST','EXPERT','MASTER','LEGEND')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ 3. Tier change history ═══

CREATE TABLE IF NOT EXISTS user_tier_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    old_tier TEXT NOT NULL,
    new_tier TEXT NOT NULL,
    reason TEXT NOT NULL,
    competition_id UUID REFERENCES competitions(id),
    week_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tier_history_user ON user_tier_history(user_id);

-- ═══ 4. User badges ═══

CREATE TABLE IF NOT EXISTS user_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_type TEXT NOT NULL CHECK (badge_type IN ('WEEKLY_CHAMPION')),
    tier TEXT NOT NULL,
    week_id TEXT NOT NULL,
    competition_id UUID NOT NULL REFERENCES competitions(id),
    metadata JSONB NOT NULL DEFAULT '{}',
    earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_badges_unique UNIQUE (user_id, badge_type, week_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- ═══ 5. Qualification flag on participants ═══

ALTER TABLE competition_participants ADD COLUMN IF NOT EXISTS qualified BOOLEAN
    NOT NULL DEFAULT false;
