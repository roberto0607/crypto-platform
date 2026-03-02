-- 031_outbox.sql  Transactional outbox for reliable side-effect delivery

CREATE TABLE outbox_events (
  id               BIGSERIAL       PRIMARY KEY,
  event_type       TEXT             NOT NULL,
  aggregate_type   TEXT             NOT NULL,
  aggregate_id     UUID             NULL,
  payload          JSONB            NOT NULL DEFAULT '{}',
  status           TEXT             NOT NULL DEFAULT 'PENDING',
  attempts         INT              NOT NULL DEFAULT 0,
  last_error       TEXT             NULL,
  next_attempt_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ      NULL,

  CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0)
);

CREATE INDEX idx_outbox_pending ON outbox_events (status, next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX idx_outbox_created ON outbox_events (created_at ASC);
