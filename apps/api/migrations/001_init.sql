-- 001_init.sql
-- Phase 1: Core Auth + Audit Schema
--
-- This migration establishes the foundational schema for authentication,
-- token management, and audit logging. All tables use IF NOT EXISTS so
-- the migration is safe to re-run (idempotent).

-- Enable pgcrypto for gen_random_uuid() used in all primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tracks which migration files have been applied. Also created
-- programmatically by migrate.ts as a bootstrap step.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Core user accounts table.
-- email_normalized enables case-insensitive uniqueness (e.g. lowercase).
-- SECURITY: password_hash stores Argon2 hashes — never store plaintext.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enforces one account per normalized email address.
  CONSTRAINT users_email_normalized_unique UNIQUE (email_normalized),
  -- Only allow known role values.
  CONSTRAINT users_role_check CHECK (role IN ('USER', 'ADMIN'))
);

-- Speeds up login lookups by normalized email.
CREATE INDEX IF NOT EXISTS users_email_normalized_idx
ON users(email_normalized);

-- Refresh tokens for JWT rotation. Tokens are stored as hashes,
-- not raw values, so a database leak does not expose valid tokens.
-- SECURITY: token_hash should be a SHA-256 (or similar) of the raw token.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: deleting a user revokes all their refresh tokens.
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- NULL means active; set to a timestamp to soft-revoke.
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Prevents token replay — each hash can only exist once.
  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash)
);

-- Look up all tokens for a user (e.g. "revoke all sessions").
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx
ON refresh_tokens(user_id);

-- Supports cleanup queries that purge expired tokens.
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx
ON refresh_tokens(expires_at);

-- Immutable, append-only audit trail for compliance and debugging.
-- actor_user_id uses SET NULL on delete so audit history is preserved
-- even if the user account is removed.
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL preserves the log row when the actor is deleted.
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NULL,
  target_id UUID NULL,
  request_id TEXT NULL,
  -- SECURITY: ip and user_agent may contain PII — apply retention policies.
  ip TEXT NULL,
  user_agent TEXT NULL,
  -- Flexible key-value payload for action-specific context.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports queries like "show all actions by user X".
CREATE INDEX IF NOT EXISTS audit_log_actor_idx
ON audit_log(actor_user_id);

-- Supports queries like "show all LOGIN_FAILED events".
CREATE INDEX IF NOT EXISTS audit_log_action_idx
ON audit_log(action);

-- Supports time-range queries and retention/purge jobs.
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
ON audit_log(created_at);

-- Auto-update updated_at on every row modification.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

