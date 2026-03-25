-- Allow streak badge types (STREAK_3, STREAK_5, STREAK_10) in user_badges.
-- Migration 061 added streak logic but never widened the CHECK or relaxed NOT NULL columns.

-- 1. Drop the badge_type CHECK that only allows 'WEEKLY_CHAMPION'
ALTER TABLE user_badges DROP CONSTRAINT IF EXISTS user_badges_badge_type_check;

-- 2. Make week_id and competition_id nullable (streak badges aren't tied to a competition)
ALTER TABLE user_badges ALTER COLUMN week_id DROP NOT NULL;
ALTER TABLE user_badges ALTER COLUMN competition_id DROP NOT NULL;
