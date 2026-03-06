-- 039_refresh_token_families.sql — Refresh token family tracking + login_attempts cleanup index

-- Add family tracking to refresh_tokens
ALTER TABLE refresh_tokens
  ADD COLUMN family_id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN replaced_by_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL;

-- Index for family lookups (revoke-all-in-family)
CREATE INDEX idx_refresh_tokens_family_id ON refresh_tokens(family_id);

-- Cleanup index for login_attempts
CREATE INDEX idx_login_attempts_created_at ON login_attempts(created_at);
