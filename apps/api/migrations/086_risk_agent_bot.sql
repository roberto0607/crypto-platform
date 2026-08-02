-- ============================================================
-- 086_risk_agent_bot.sql
-- Create the Risk Agent's dedicated bot user (Gate 1d).
-- ============================================================
--
-- Context:
--   Same pattern as migration 049 (market-maker bot user) -- confirmed
--   generic, not market-maker-specific. Risk Agent evaluates trade
--   proposals against THIS account's live equity (via
--   portfolioService.getPortfolioSummary), and risk_reservations
--   (migration 087) is scoped to it. Unlike the market-maker bot, this
--   account never places orders itself in this gate -- Gate 1e
--   (Execution Agent) is what would eventually act on approved
--   proposals using this account's wallet.
-- ============================================================

INSERT INTO users (id, email, email_normalized, password_hash, display_name, role)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    'riskagent@system.local',
    'riskagent@system.local',
    -- Placeholder hash — bot never logs in via password
    '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
    'Risk Agent',
    'USER'
) ON CONFLICT (email_normalized) DO NOTHING;
