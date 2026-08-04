-- ============================================================
-- 088_execution_agent.sql
-- Schema groundwork for the Execution Agent (Gate 1e).
-- ============================================================
--
-- Context:
--   Gate 1e turns an `approved` trade_proposals row into a real order on
--   the Risk Agent's bot account, then protects it with a stop/target
--   OCO pair. Two additive changes, both confirmed necessary in the
--   design lock's own recon:
--
--   1. trigger_orders had no way to trace a trigger back to the
--      proposal that spawned it (it's a standalone (user_id, pair_id,
--      side, qty, trigger_price) tuple with no FK to a position/order).
--      Execution Agent's own crash-recovery job (scan for `executed`
--      proposals with no matching ACTIVE trigger_orders) depends on
--      this column existing.
--
--   2. trade_proposals.outcome needs a state for "tolerance check
--      failed, no order was ever placed" that is NOT the same as Risk
--      Agent's own `rejected` (a risk decision) or `expired` (never
--      evaluated in time) -- this is a distinct execution-time timing
--      failure. Kept separate so agent_decisions stays easy to read
--      later (see design doc).
-- ============================================================

ALTER TABLE trigger_orders
    ADD COLUMN trade_proposal_id UUID REFERENCES trade_proposals(id);

CREATE INDEX idx_trigger_orders_trade_proposal
    ON trigger_orders (trade_proposal_id)
    WHERE trade_proposal_id IS NOT NULL;

ALTER TABLE trade_proposals
    DROP CONSTRAINT trade_proposals_outcome_check;

ALTER TABLE trade_proposals
    ADD CONSTRAINT trade_proposals_outcome_check
    CHECK (outcome IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'execution_failed'));
