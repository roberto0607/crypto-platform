-- ============================================================
-- 090_trade_proposals_human_alerted_at.sql
-- Dedupe marker for the Gate 1e human-alerting escalation: a stuck
-- trade_proposals row (protection registration failed, auto-flatten
-- failed, AND the crash-recovery job's own retry also failed) pages a
-- human exactly once, not once per 60s recovery-job tick.
-- ============================================================
--
-- Context:
--   executionAgentRecoveryJob.ts re-flags any row with
--   flatten_order_id IS NULL every 60s tick, indefinitely, for a
--   persistently stuck row. Without a claim column,
--   registerProtectionOrFlatten's origin==='recovery' && !flattenOrderId
--   branch would send one email per tick, forever.
--
--   Claimed via a single UPDATE ... WHERE human_alerted_at IS NULL
--   RETURNING id -- mirrors alertRepo.ts's markFiredEveryNMinutes
--   race-safe claim pattern, but as a one-time claim (no interval),
--   since a stuck row doesn't self-resolve.
--
--   Nullable, additive, same convention as flatten_order_id (089).
-- ============================================================

ALTER TABLE trade_proposals
    ADD COLUMN human_alerted_at TIMESTAMPTZ;
