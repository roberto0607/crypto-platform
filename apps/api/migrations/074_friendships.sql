-- 074_friendships.sql  —  Social chat Phase 1: Friendships
--
-- Directional row: user_id = requester, friend_id = recipient. status starts
-- 'pending' and transitions to 'accepted' or 'blocked'. Either side of an
-- accepted friendship can block the other by flipping status to 'blocked'.
-- Rejecting a pending request deletes the row (app-layer, not here) so a
-- fresh request can be sent later.
--
-- The pair-uniqueness index is on (LEAST, GREATEST) of the two ids, not a
-- plain UNIQUE(user_id, friend_id) — otherwise A→B and B→A could both exist
-- as separate pending rows.

CREATE TABLE friendships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
               'pending', 'accepted', 'blocked'
             )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT friendships_no_self_friend CHECK (user_id <> friend_id)
);

CREATE UNIQUE INDEX idx_friendships_pair
  ON friendships (LEAST(user_id, friend_id), GREATEST(user_id, friend_id));

-- Lookups: "requests sent to me" / "my pending outgoing requests" / "my
-- accepted friends" all filter by one side + status.
CREATE INDEX idx_friendships_friend_status ON friendships (friend_id, status);
CREATE INDEX idx_friendships_user_status ON friendships (user_id, status);

CREATE TRIGGER trg_friendships_updated
  BEFORE UPDATE ON friendships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
