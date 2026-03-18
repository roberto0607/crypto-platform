-- Phase 1 schema simplification: drop exchange-complexity tables
-- These tables supported real-exchange features (reconciliation, risk limits,
-- circuit breakers, governance) that are unnecessary for paper trading.

DROP TABLE IF EXISTS incident_events CASCADE;
DROP TABLE IF EXISTS incidents CASCADE;
DROP TABLE IF EXISTS repair_runs CASCADE;
DROP TABLE IF EXISTS reconciliation_reports CASCADE;
DROP TABLE IF EXISTS account_limits CASCADE;
DROP TABLE IF EXISTS circuit_breakers CASCADE;
DROP TABLE IF EXISTS risk_limits CASCADE;
DROP TABLE IF EXISTS user_quotas CASCADE;
