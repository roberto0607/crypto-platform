-- ============================================================
-- 093_unique_display_name.sql
-- Handles (users.display_name) become unique, case-insensitively.
-- ============================================================
--
-- The landing page lets a visitor pick a handle before signing up
-- (GET /v1/handles/available, then POST /auth/register {displayName}).
-- "Available" has to mean something, so two accounts can no longer hold
-- the same handle in different case. PUT /v1/profile/display-name already
-- maps a 23505 on this column to 409 display_name_taken.
--
-- Partial: NULL display names (most accounts) are unconstrained.
--
-- PRE-DEPLOY CHECK: this fails if duplicates already exist. Before merging,
-- confirm zero rows from
--   SELECT lower(display_name), count(*) FROM users
--   WHERE display_name IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_lower_unique
    ON users (lower(display_name))
    WHERE display_name IS NOT NULL;
