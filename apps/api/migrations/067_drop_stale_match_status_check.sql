-- Migration 067: Drop stale matches.status CHECK constraint
--
-- Migration 057_trade_wars.sql declared a CHECK constraint listing
-- ('PENDING','ACTIVE','COMPLETED','FORFEITED','EXPIRED'). Production
-- diverged from this — the constraint was dropped (likely via an
-- untracked ALTER) to accommodate the CANCELLED and OVERTIME states
-- the cleanup job and cancel paths actually write. A fresh DB built
-- from migrations would still have the original CHECK and would
-- reject CANCELLED writes.
--
-- This migration drops the constraint idempotently so tracked
-- migrations match production reality. A future migration may
-- re-add a corrected CHECK covering all real statuses
-- (PENDING, ACTIVE, OVERTIME, COMPLETED, FORFEITED, EXPIRED, CANCELLED)
-- once 4b finalizes the match-resolution state machine.

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_status_check;
