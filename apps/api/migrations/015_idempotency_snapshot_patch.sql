-- Phase 6 PR1 patch: Store snapshot JSON in idempotency keys
-- for deterministic retry responses.
--
-- DEFAULT '{}'::jsonb exists solely as a backfill placeholder for any
-- rows that were inserted before this migration. All new inserts via
-- putIdempotencyKeyTx() MUST provide a real Snapshot object.
-- A value of '{}' in snapshot_json indicates a legacy row and should
-- never appear for requests created after this migration.
ALTER TABLE idempotency_keys
    ADD COLUMN snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;
