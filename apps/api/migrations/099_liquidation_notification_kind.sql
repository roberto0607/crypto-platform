-- Migration 099: notification kind for liquidations (leverage PR 4)
--
-- The liquidation engine (trading/liquidationEngine.ts) tells the user with a
-- bell notification when it closes a position. Same list as 048 plus
-- POSITION_LIQUIDATED.
--
-- NOT VALID: every existing row already passed 048's narrower constraint, so
-- re-scanning the table under an exclusive lock at deploy buys nothing. New
-- and updated rows are checked as usual.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'COMPETITION_STARTED',
        'COMPETITION_ENDED',
        'COMPETITION_JOINED',
        'RANK_CHANGED',
        'TRIGGER_FIRED',
        'ORDER_FILLED',
        'SYSTEM',
        'TIER_PROMOTION',
        'TIER_DEMOTION',
        'WEEKLY_CHAMPION',
        'POSITION_LIQUIDATED'
    )) NOT VALID;
