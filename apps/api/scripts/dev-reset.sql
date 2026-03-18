-- Dev reset: run this when things go sideways
-- Usage: pnpm dev:db-reset
-- (Phase 1 simplification removed the tables that needed resetting)
SELECT 'No-op: exchange tables dropped in Phase 1' AS status;
