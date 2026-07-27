-- 076_flagged_messages.sql  —  Social chat Phase 4: Moderation (reports)
--
-- message_id is nullable with ON DELETE SET NULL, not CASCADE — match chat
-- messages get hard-deleted the instant a match ends (Phase 3), and a report
-- filed while the match was still active must survive that purge. body_snapshot
-- + sender_id + conversation_type are denormalized copies for exactly that
-- reason: they're the record once the source message is gone.

CREATE TABLE flagged_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID REFERENCES messages(id) ON DELETE SET NULL,
  body_snapshot     TEXT,
  sender_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reporter_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_type TEXT NOT NULL CHECK (conversation_type IN ('dm', 'match')),
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_flagged_messages_created ON flagged_messages (created_at DESC);
CREATE INDEX idx_flagged_messages_sender ON flagged_messages (sender_id);
