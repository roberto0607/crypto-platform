-- Phase 15 PR4: In-app notification system

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (
        'COMPETITION_STARTED',
        'COMPETITION_ENDED',
        'COMPETITION_JOINED',
        'RANK_CHANGED',
        'TRIGGER_FIRED',
        'ORDER_FILLED',
        'SYSTEM'
    )),
    title TEXT NOT NULL,
    body TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread
    ON notifications(user_id, created_at DESC)
    WHERE read_at IS NULL;

CREATE INDEX idx_notifications_user_recent
    ON notifications(user_id, created_at DESC);
