-- 032_backup_metadata.sql
-- Tracks automated backup files and their restore-drill verification status.

CREATE TABLE backup_metadata (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  filename         TEXT        NOT NULL,
  size_bytes       BIGINT      NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_restore BOOLEAN     NOT NULL DEFAULT false,
  verified_at      TIMESTAMPTZ NULL
);

CREATE INDEX idx_backup_metadata_created ON backup_metadata (created_at DESC);
