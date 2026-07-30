-- ============================================================
-- 081_agent_run_logs.sql
-- Agent invocation observability log.
-- ============================================================
--
-- Context:
--   The observability layer for the agent system, built now even though
--   no agent exists yet so Gate 1b has somewhere to write from day one.
--   One row per agent invocation (success or failure), independent of
--   whether that invocation produced a decision/proposal.
--
-- Modeled directly on audit_log (001_init.sql): UUID PK, nullable actor
-- FK with ON DELETE SET NULL (preserve the log row if the user is
-- deleted), a target_type/target_id triad for polymorphic linking (e.g.
-- target_type='trade_proposal', target_id=<uuid>), request_id for
-- tracing, and a metadata JSONB catch-all for the variable-shaped
-- inputs/outputs payload — same "flexible key-value payload" role
-- audit_log.metadata plays. agent_name/status/latency_ms/cost_usd/error
-- are pulled out as first-class columns (not buried in metadata) since
-- these are the fields Gate 1b's per-agent dashboards will filter/sort
-- by most often.
-- ============================================================

CREATE TABLE agent_run_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name TEXT NOT NULL,
    -- SET NULL preserves the log row when the actor is deleted.
    actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    target_type TEXT NULL,
    target_id UUID NULL,
    status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
    latency_ms INTEGER,
    cost_usd NUMERIC(10,6),
    error TEXT,
    request_id TEXT NULL,
    -- Flexible key-value payload: inputs, outputs, and any other
    -- run-specific context.
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports "show all runs of agent X" — the main per-agent dashboard query.
CREATE INDEX idx_agent_run_logs_agent
    ON agent_run_logs (agent_name, created_at DESC);

-- Supports "show all agent runs made on behalf of user X".
CREATE INDEX idx_agent_run_logs_actor
    ON agent_run_logs (actor_user_id);

-- Supports time-range queries and retention/purge jobs.
CREATE INDEX idx_agent_run_logs_created_at
    ON agent_run_logs (created_at);

-- Hot path: "show recent failures" without scanning successes.
CREATE INDEX idx_agent_run_logs_failures
    ON agent_run_logs (created_at DESC)
    WHERE status <> 'success';
