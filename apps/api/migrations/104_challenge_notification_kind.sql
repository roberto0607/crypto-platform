-- Notification kind for an incoming 1v1 challenge, so it reaches the bell.
-- Same NOT VALID shape as migration 099: existing rows aren't rescanned.
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
        'POSITION_LIQUIDATED',
        'CHALLENGE_RECEIVED'
    )) NOT VALID;
