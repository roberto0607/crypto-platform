-- 038_login_attempts.sql — Login abuse protection

CREATE TABLE login_attempts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_normalized TEXT NOT NULL,
    ip_address       TEXT NOT NULL,
    success          BOOLEAN NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_attempts_email_created
    ON login_attempts (email_normalized, created_at DESC);

CREATE INDEX idx_login_attempts_ip_created
    ON login_attempts (ip_address, created_at DESC);
