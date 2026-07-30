-- ============================================================
-- 080_agent_decisions.sql
-- Per-cycle agent decision log with multi-horizon outcome grading.
-- ============================================================
--
-- Context:
--   Broader than trade_proposals (079) — one row per agent decision
--   cycle, not just the ones that produce a proposal (e.g. "hold",
--   "flag_risk", "close_position" are decisions too). This is what the
--   future Journal Agent reads from to grade agent performance over
--   time.
--
-- Modeled closely on signal_log (migration 056), which already solved
-- "log a scored decision with regime context, then backfill outcome at
-- multiple future horizons via a grading job" for the unrelated adaptive
-- ML-learning subsystem. The outcome_30m/1h/4h + price_30m/1h/4h +
-- graded_at columns are lifted directly from that precedent — no
-- grading job exists yet (Gate 1b+), these just stay NULL until one
-- does, same deferred-fill pattern signal_log and ml_signals both use.
-- ============================================================

CREATE TABLE agent_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name TEXT NOT NULL,
    pair_id UUID REFERENCES trading_pairs(id),
    decision TEXT NOT NULL,
    reasoning TEXT,
    regime TEXT,
    regime_confidence NUMERIC(5,4),
    -- What the agent saw when it decided (indicator snapshot, context) —
    -- flexible payload, same role as audit_log.metadata.
    inputs JSONB,
    weights_used JSONB,
    trade_proposal_id UUID REFERENCES trade_proposals(id) ON DELETE SET NULL,
    price_at_decision NUMERIC(28,8),
    outcome_30m TEXT,
    outcome_1h TEXT,
    outcome_4h TEXT,
    price_30m NUMERIC(28,8),
    price_1h NUMERIC(28,8),
    price_4h NUMERIC(28,8),
    graded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports "show all decisions by agent X" (Journal Agent's main query).
CREATE INDEX idx_agent_decisions_agent
    ON agent_decisions (agent_name, created_at DESC);

CREATE INDEX idx_agent_decisions_pair
    ON agent_decisions (pair_id, created_at DESC);

-- Hot path for the (future) grading job: "decisions still awaiting a
-- graded outcome".
CREATE INDEX idx_agent_decisions_ungraded
    ON agent_decisions (created_at)
    WHERE graded_at IS NULL;
