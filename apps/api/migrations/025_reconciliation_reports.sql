-- Phase 9 PR5: Reconciliation reports (persistent findings)
CREATE TABLE reconciliation_reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID NOT NULL,
    user_id     UUID NULL,
    severity    TEXT NOT NULL,
    check_name  TEXT NOT NULL,
    details     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT recon_reports_severity_check
        CHECK (severity IN ('INFO', 'WARN', 'HIGH'))
);

CREATE INDEX idx_recon_reports_user_created_at
    ON reconciliation_reports (user_id, created_at DESC);

CREATE INDEX idx_recon_reports_run_id
    ON reconciliation_reports (run_id);

CREATE INDEX idx_recon_reports_severity
    ON reconciliation_reports (severity);
