-- ============================================================
-- 083_trade_proposals_chart_config.sql
-- Add chart_config to trade_proposals for the Chart Analysis Agent.
-- ============================================================
--
-- Context:
--   Gate 1c's Chart Analysis Agent is the first to write trade_proposals
--   rows. Per the Gate 1c design doc's Q1 decision, the agent's
--   proposeChartConfig tool never mutates a live frontend chart -- it
--   only produces a suggested indicator/timeframe/drawing setup, stored
--   here for a future UI to render as an "apply this chart setup" button.
-- ============================================================

ALTER TABLE trade_proposals ADD COLUMN chart_config JSONB;
