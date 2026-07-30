-- ============================================================
-- 079_trade_proposals.sql
-- Agent-produced trade proposals, pending Risk-agent approval.
-- ============================================================
--
-- Context:
--   Gate 1a lays the DB groundwork for the future Scanner/Chart Analysis
--   agents to propose trades and a Risk agent to gate them before
--   execution. No agent code exists yet (Gate 1b) — this table exists so
--   Gate 1b has somewhere to write from day one.
--
-- Modeled closely on ml_signals (migrations 050 + 053), which already
-- solved "confidence-scored directional call with regime tagging, a
-- JSONB feature/forecast payload, and an outcome state machine" for the
-- unrelated ML-signal pipeline. trade_proposals adds the explainability
-- fields (entry/stop/target reasons, trade_type, risk_reward_ratio) and
-- an agent_name column, since — unlike ml_signals' single model
-- pipeline — proposals can come from more than one agent.
--
-- outcome is the proposal's own lifecycle (pending -> approved/rejected
-- by the Risk agent -> executed, or expired unacted), not a price-target
-- hit/miss outcome like ml_signals uses — that grading concept lives on
-- agent_decisions instead (migration 080).
-- ============================================================

CREATE TABLE trade_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    agent_name TEXT NOT NULL,
    model_version TEXT,
    timeframe TEXT NOT NULL,
    trade_type TEXT NOT NULL CHECK (trade_type IN ('scalp', 'swing')),
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    entry_price NUMERIC(28,8) NOT NULL,
    stop_price NUMERIC(28,8) NOT NULL,
    target_price NUMERIC(28,8) NOT NULL,
    qty NUMERIC(28,8) NOT NULL,
    risk_reward_ratio NUMERIC(6,2),
    confidence NUMERIC(5,2) NOT NULL,
    entry_reason TEXT NOT NULL,
    stop_reason TEXT NOT NULL,
    target_reason TEXT NOT NULL,
    regime TEXT,
    regime_confidence NUMERIC(5,4),
    top_features JSONB,
    forecast JSONB,
    outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK (outcome IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
    -- Set once the Risk/Execution agents (Gate 1b+) turn this proposal
    -- into a real order. SET NULL preserves the proposal if the order
    -- is later deleted (orders are never hard-deleted today, but match
    -- the FK-safety convention used elsewhere in this schema).
    executed_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ
);

-- Supports "latest proposals for this pair/timeframe".
CREATE INDEX idx_trade_proposals_pair
    ON trade_proposals (pair_id, timeframe, created_at DESC);

-- Hot path for the (future) Risk agent's approval queue.
CREATE INDEX idx_trade_proposals_pending
    ON trade_proposals (outcome)
    WHERE outcome = 'pending';

CREATE INDEX idx_trade_proposals_agent
    ON trade_proposals (agent_name, created_at DESC);
