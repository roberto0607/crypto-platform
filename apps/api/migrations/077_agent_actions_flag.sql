-- ============================================================
-- 077_agent_actions_flag.sql
-- Agent-actions kill switch flag.
-- ============================================================
--
-- Context:
--   Gate 1a (AI agent trading system foundation) needs a way to halt
--   agent-originated order placement without touching manual user
--   trading. system_flags already exists (migration 036) with
--   TRADING_ENABLED_GLOBAL/READ_ONLY_MODE, but those are checked nowhere
--   in the order path today and are not agent-specific. This adds a new,
--   dedicated flag following the exact same key/value shape.
--
-- What this migration does NOT do:
--   Does not wire enforcement — that's a code change in
--   phase6OrderService.ts (same PR), gated on orders.source = 'agent'
--   (see migration 078). This migration only adds the flag row itself.
-- ============================================================

INSERT INTO system_flags (key, value) VALUES
    ('AGENT_ACTIONS_ENABLED', '{"enabled": true}')
ON CONFLICT (key) DO NOTHING;
