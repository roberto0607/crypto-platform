-- 075_conversations_messages.sql  —  Social chat Phase 2: Friends DM
--
-- conversations is generic (type 'dm' | 'match') so Phase 3's match chat
-- reuses this same schema — context_id is NULL for 'dm', match_id for
-- 'match'. DM conversations have no context_id; two-user DM dedup happens
-- at the query layer (find a 'dm' conversation both users are in), not via
-- a schema constraint. Match conversations are unique per match via the
-- partial index below.
--
-- messages.image_url exists now (per the locked design) but stays unused
-- until the R2 upload endpoint ships — body-only messages this phase.

CREATE TABLE conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL CHECK (type IN ('dm', 'match')),
  context_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_conversations_match_context
  ON conversations (context_id) WHERE type = 'match';

CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_conversation_participants_user ON conversation_participants (user_id);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT,
  image_url       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ,

  CONSTRAINT messages_body_or_image CHECK (body IS NOT NULL OR image_url IS NOT NULL)
);

-- Keyset pagination on (conversation_id, created_at DESC, id DESC), same
-- shape as ledger_entries' (created_at, id) cursor (see http/pagination.ts).
CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at DESC, id DESC);
