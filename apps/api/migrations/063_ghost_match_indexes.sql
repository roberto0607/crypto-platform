-- Enforce at most one ACTIVE or PENDING match per user at the DB level.
-- Prevents ghost matches from blocking new challenges even if cleanup job misses them.

CREATE UNIQUE INDEX IF NOT EXISTS one_active_match_per_challenger
ON matches (challenger_id)
WHERE status IN ('ACTIVE', 'PENDING');

CREATE UNIQUE INDEX IF NOT EXISTS one_active_match_per_opponent
ON matches (opponent_id)
WHERE status IN ('ACTIVE', 'PENDING');

-- Add CANCELLED to the status check if one exists (matches use TEXT, so no enum change needed).
