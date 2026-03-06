-- Email verification tracking
ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMPTZ DEFAULT NULL;

-- Grandfather existing users as verified
UPDATE users SET email_verified_at = created_at;

-- Verification tokens (email verification + password reset)
CREATE TABLE email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EMAIL_VERIFY', 'PASSWORD_RESET')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_tokens_hash ON email_tokens(token_hash) WHERE used_at IS NULL;
CREATE INDEX idx_email_tokens_user_kind ON email_tokens(user_id, kind) WHERE used_at IS NULL;
