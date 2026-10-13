-- Migration 094: scope trigger orders to the account they were created in
--
-- Until now a TP/SL/trailing trigger had no scope: fireTrigger routed its
-- derived order to whatever match the user was in AT FIRE TIME
-- (getActiveMatchIdForUser). A free-play stop created before joining a match
-- would therefore fire into the match wallet and close the match position,
-- leaving the free-play position it was meant to protect open (follow-up from
-- PR #202).
--
-- trigger_orders.match_id records the scope at creation: the user's ACTIVE
-- match at that moment, or NULL for free-play. Existing rows stay NULL, i.e.
-- free-play — the same scope the old fire-time lookup gave them whenever the
-- user wasn't in a match.
--
-- ON DELETE CASCADE, not SET NULL like orders/positions/wallets (066): a NULL
-- match_id means free-play here, so SET NULL would silently re-scope a deleted
-- match's triggers onto the user's free-play account.

ALTER TABLE trigger_orders ADD COLUMN IF NOT EXISTS match_id UUID DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'trigger_orders_match_fk'
          AND conrelid = 'trigger_orders'::regclass
    ) THEN
        ALTER TABLE trigger_orders
            ADD CONSTRAINT trigger_orders_match_fk
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Match end cancels the match's ACTIVE triggers by match_id.
CREATE INDEX IF NOT EXISTS idx_trigger_orders_match_active
    ON trigger_orders (match_id)
    WHERE match_id IS NOT NULL AND status = 'ACTIVE';
