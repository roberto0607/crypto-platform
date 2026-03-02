-- Phase 9 PR7: Incident events (append-only timeline)
-- Immutable audit trail for incident lifecycle actions.

CREATE TABLE incident_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id     UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_incident_event_type CHECK (
        event_type IN (
            'OPENED', 'ACKNOWLEDGED', 'NOTE',
            'REPAIR_STARTED', 'REPAIR_APPLIED',
            'RECON_CLEAN', 'RECON_FAILED',
            'UNQUARANTINE_ATTEMPT', 'RESOLVED'
        )
    )
);

CREATE INDEX idx_incident_events_incident_created
    ON incident_events (incident_id, created_at ASC);
