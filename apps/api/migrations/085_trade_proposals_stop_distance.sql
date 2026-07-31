-- ============================================================
-- 085_trade_proposals_stop_distance.sql
-- Add server-computed stop-distance columns to trade_proposals.
-- ============================================================
--
-- Context:
--   Hand-checking 8 real Chart Analysis Agent proposals found the model's
--   own stated stop-distance arithmetic (e.g. "25bp below entry", "~1.7x
--   ATR") wrong in 4 of 6 checkable cases -- off by 2x to 6x from what its
--   own entryPrice/stopPrice values actually imply. The prices themselves
--   were fine (grounded in real EMA/BB/VWAP/ATR values); only the model's
--   own restated arithmetic about those prices was unreliable.
--
--   Same fix philosophy as migration 084 (qty nullable): don't let the
--   model assert a number it can get wrong -- compute it server-side
--   instead. stop_distance_pct and stop_distance_atr_multiple are
--   computed by the runner from entry_price/stop_price (and the last ATR
--   value seen during the run), never asked of the model.
--
--   Both nullable: stop_distance_atr_multiple especially, since a run
--   isn't guaranteed to call getIndicators with "atr" in its indicator
--   list.
-- ============================================================

ALTER TABLE trade_proposals
    ADD COLUMN stop_distance_pct NUMERIC(10,6),
    ADD COLUMN stop_distance_atr_multiple NUMERIC(10,4);
