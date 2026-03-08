-- Add tier/badge notification kinds to notifications check constraint

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
        'WEEKLY_CHAMPION'
    ));
