-- ============================================================
-- 089_trade_proposals_flatten_order_id.sql
-- Distinguishes "auto-flatten succeeded" from "crashed before Phase 2"
-- / "auto-flatten also failed" for the Execution Agent (Gate 1e).
-- ============================================================
--
-- Context:
--   Both cases leave trade_proposals in outcome='executed' with no
--   complete, healthy STOP_MARKET/TAKE_PROFIT_MARKET pair in
--   trigger_orders -- structurally indistinguishable from each other
--   without this column. Today the only trace of which case occurred
--   is free text inside agent_decisions.reasoning. Same rationale as
--   088's execution_failed outcome value: a real column instead of
--   string-matching.
--
--   Mirrors executed_order_id (migration 079) exactly: nullable, FK
--   to orders(id), ON DELETE SET NULL.
-- ============================================================

ALTER TABLE trade_proposals
    ADD COLUMN flatten_order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
