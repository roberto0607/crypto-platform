-- Migration 097: SOL maintenance margin = 1%
--
-- The approved maintenance-margin rates (docs/designs/2026-10-13-leverage-
-- design.md, decision 3) are 0.5% for BTC/ETH and 1% for SOL. Migration 096
-- added trading_pairs.maintenance_margin_bps with DEFAULT 50 for every pair
-- and deferred SOL's value to the PR whose engine reads the column (this one).
--
-- Data only, SOL-based pairs only. Every other pair keeps 50. Idempotent.
-- 100 bps × the default max_leverage 10 = 1000 < 10000, inside
-- trading_pairs_margin_params_check.
UPDATE trading_pairs tp
SET maintenance_margin_bps = 100
FROM assets a
WHERE a.id = tp.base_asset_id
  AND a.symbol = 'SOL'
  AND tp.maintenance_margin_bps <> 100;
