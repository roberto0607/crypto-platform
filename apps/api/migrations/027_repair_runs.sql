-- 027_repair_runs.sql  —  Phase 9 PR6: repair run tracking

CREATE TABLE IF NOT EXISTS repair_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    target_user_id  UUID NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'APPLY')),
    scope           TEXT NOT NULL CHECK (scope IN ('USER_ALL_PAIRS', 'USER_PAIR')),
    pair_id         UUID,
    from_ts         TIMESTAMPTZ,
    to_ts           TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
    summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_repair_runs_target_created
    ON repair_runs (target_user_id, created_at DESC);
