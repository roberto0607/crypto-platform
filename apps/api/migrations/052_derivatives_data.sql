-- Derivatives data snapshots (funding rates, open interest, long/short ratios)
-- Polled from Binance Futures REST API every 60 seconds

CREATE TABLE derivatives_snapshots (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id              UUID NOT NULL REFERENCES trading_pairs(id),
    ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Funding rate
    funding_rate         NUMERIC(12,8),
    funding_time         TIMESTAMPTZ,
    mark_price           NUMERIC(20,8),

    -- Open interest
    open_interest        NUMERIC(20,4),
    open_interest_usd    NUMERIC(20,2),
    oi_change_pct        NUMERIC(8,4),

    -- Global long/short ratio
    global_ls_ratio      NUMERIC(8,4),
    global_long_pct      NUMERIC(6,4),
    global_short_pct     NUMERIC(6,4),

    -- Top trader long/short ratio
    top_ls_ratio         NUMERIC(8,4),
    top_long_pct         NUMERIC(6,4),
    top_short_pct        NUMERIC(6,4),

    -- Inferred liquidation pressure
    liq_pressure         NUMERIC(8,4),
    liq_intensity        NUMERIC(8,4)
);

CREATE INDEX idx_deriv_pair_ts ON derivatives_snapshots (pair_id, ts DESC);
