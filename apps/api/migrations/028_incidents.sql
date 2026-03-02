-- Phase 9 PR7: Incidents table
-- Tracks quarantine case files with admin acknowledgement and resolution workflow.

CREATE TABLE incidents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'OPEN',
    severity            TEXT NOT NULL DEFAULT 'HIGH',
    opened_by           TEXT NOT NULL,
    opened_reason       TEXT NOT NULL,
    recon_run_id        UUID,
    latest_report_id    UUID,
    acknowledged_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at     TIMESTAMPTZ,
    resolved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    resolution_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_incident_status CHECK (status IN ('OPEN', 'INVESTIGATING', 'RESOLVED')),
    CONSTRAINT chk_incident_severity CHECK (severity IN ('HIGH', 'CRITICAL'))
);

CREATE INDEX idx_incidents_user_status ON incidents (user_id, status);
CREATE INDEX idx_incidents_created_at ON incidents (created_at DESC);
CREATE UNIQUE INDEX idx_incidents_user_recon_run
    ON incidents (user_id, recon_run_id) WHERE recon_run_id IS NOT NULL;

CREATE TRIGGER trg_incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
