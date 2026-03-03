-- Phase 10 PR6: Beta invite system
CREATE TABLE beta_invites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT UNIQUE NOT NULL,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    max_uses    INT NOT NULL DEFAULT 1,
    used_count  INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NULL,
    disabled    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT invites_max_uses_positive CHECK (max_uses > 0),
    CONSTRAINT invites_used_count_range CHECK (used_count >= 0 AND used_count <= max_uses)
);

CREATE INDEX idx_beta_invites_code ON beta_invites (code) WHERE disabled = false;
