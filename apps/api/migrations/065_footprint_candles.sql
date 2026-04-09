-- Footprint candle data — aggregated trade volume per price bucket per candle.
-- Stores completed candle footprints for last 24 hours.
-- Buckets are $10 price increments with buy/sell quantities.

CREATE TABLE IF NOT EXISTS footprint_candles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair VARCHAR(20) NOT NULL,
    timeframe VARCHAR(5) NOT NULL,
    open_time TIMESTAMPTZ NOT NULL,
    close_time TIMESTAMPTZ NOT NULL,
    buckets JSONB NOT NULL DEFAULT '{}',
    total_buy_qty NUMERIC(20,8) NOT NULL DEFAULT 0,
    total_sell_qty NUMERIC(20,8) NOT NULL DEFAULT 0,
    delta NUMERIC(20,8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS footprint_candles_unique
    ON footprint_candles(pair, timeframe, open_time);

CREATE INDEX IF NOT EXISTS footprint_candles_lookup
    ON footprint_candles(pair, timeframe, open_time DESC);
