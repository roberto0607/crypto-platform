-- 030_event_stream.sql
-- Append-only hash-linked event stream for tamper-evident audit

CREATE TABLE event_stream (
  id                  BIGSERIAL       PRIMARY KEY,
  event_type          TEXT            NOT NULL,
  entity_type         TEXT            NOT NULL,
  entity_id           UUID            NULL,
  actor_user_id       UUID            NULL,
  payload             JSONB           NOT NULL DEFAULT '{}',
  previous_event_hash TEXT            NOT NULL,
  event_hash          TEXT            NOT NULL,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

  CONSTRAINT chk_event_hash_len
    CHECK (char_length(event_hash) = 64),

  CONSTRAINT chk_prev_hash_len
    CHECK (previous_event_hash = 'GENESIS' OR char_length(previous_event_hash) = 64),

  CONSTRAINT uq_event_hash UNIQUE (event_hash)
);

CREATE INDEX idx_event_stream_created ON event_stream (created_at ASC);
CREATE INDEX idx_event_stream_entity  ON event_stream (entity_type, entity_id);

-- Prevent UPDATE/DELETE via trigger (defense in depth)
CREATE OR REPLACE FUNCTION event_stream_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'event_stream is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_event_stream_no_update
  BEFORE UPDATE ON event_stream
  FOR EACH ROW EXECUTE FUNCTION event_stream_immutable();

CREATE TRIGGER trg_event_stream_no_delete
  BEFORE DELETE ON event_stream
  FOR EACH ROW EXECUTE FUNCTION event_stream_immutable();
