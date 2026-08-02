-- ============================================================
-- 087_risk_reservations.sql
-- Tracks risk currently reserved by approved trade_proposals (Gate 1d).
-- ============================================================
--
-- Context:
--   positions has no stop-loss/risk field (pure fill-accounting: qty,
--   avg entry price, realized PnL) and collapses multiple fills into
--   one row per (user, pair, competition, match) -- so a proposal's
--   original risk figure can't be reconstructed from position state
--   after the fact, and partial closes can't be cleanly attributed back
--   to a specific originating proposal. This table exists purely so the
--   Risk Agent's exposure cap (5% of equity, see design doc) can be
--   computed without that reconstruction.
--
--   No status/released_at column, no separate release job. "Still
--   reserved" is computed live at evaluation time via an EXISTS join
--   against positions -- a reservation only counts toward current
--   exposure if its (user_id, pair_id) still has a nonzero base_qty
--   (see riskAgent/reservationRepo.ts). Known v1 simplification: a
--   pair's full reserved risk stays counted until that pair's position
--   is COMPLETELY flat -- a partial close doesn't proportionally
--   release risk. Conservative (slightly overstates outstanding risk)
--   rather than requiring fragile partial-attribution logic.
-- ============================================================

CREATE TABLE risk_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id UUID NOT NULL REFERENCES trade_proposals(id),
    user_id UUID NOT NULL REFERENCES users(id),
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    risk_amount_quote NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: sum open risk for a user (the Risk Agent's exposure-cap query).
CREATE INDEX idx_risk_reservations_user
    ON risk_reservations (user_id, pair_id);

CREATE INDEX idx_risk_reservations_proposal
    ON risk_reservations (proposal_id);
