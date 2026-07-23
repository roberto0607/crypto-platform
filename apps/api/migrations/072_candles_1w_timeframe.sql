-- Migration 072: add '1w' (weekly) to candles.timeframe
--
-- Adds native weekly candle support alongside the existing 1m/5m/15m/1h/4h/1d
-- set. Like 4h (rolled up from 1h, no native exchange source), 1w is rolled
-- up locally from 1d candles — 7 daily candles -> 1 weekly candle. See
-- candleBackfill.ts (rollup1wFromDaily, boot backfill) and
-- scripts/backfillCandles.ts (Phase 4, full-history backfill).

ALTER TABLE candles DROP CONSTRAINT candles_timeframe_check;

ALTER TABLE candles ADD CONSTRAINT candles_timeframe_check CHECK (
    timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d', '1w')
);
