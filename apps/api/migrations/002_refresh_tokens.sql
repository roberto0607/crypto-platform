-- Refresh tokens (hashed-at-rest, rotatable)
-- Assumes users(id) is UUID and schema_migrations exists.

BEGIN;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent duplicate hashes (helps catch accidental double-inserts)
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_uq
    ON refresh_tokens(token_hash);

-- Useful lookup index by user
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx
    ON refresh_tokens(user_id);

-- Useful lookup index by user
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx
    ON refresh_tokens(expires_at);

COMMIT;