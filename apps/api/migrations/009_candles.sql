-- Phase 5 PR1: Candle (OHLCV) storage for market data replay
CREATE TABLE candles (
    pair_id UUID NOT NULL REFERENCES trading_pairs(id),
    timeframe TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    open NUMERIC(28, 8) NOT NULL,
    high NUMERIC(28, 8) NOT NULL,
    low NUMERIC(28, 8) NOT NULL,
    close NUMERIC(28, 8) NOT NULL,
    volume NUMERIC(28, 8) NOT NULL DEFAULT 0,
    PRIMARY KEY (pair_id, timeframe, ts),
    CONSTRAINT candles_timeframe_check CHECK (
        timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')
    ),
    CONSTRAINT candles_ohlc_positive CHECK (
        open > 0 AND high > 0 AND low > 0 AND close > 0
    ),
    CONSTRAINT candles_hl_range CHECK (high >= low),
    CONSTRAINT candles_volume_nonneg CHECK (volume >= 0)
);

-- Query pattern: SELECT ... WHERE pair_id = $1 AND timeframe = $2 ORDER BY ts DESC LIMIT $3
-- PK already covers (pair_id, timeframe, ts ASC). Add DESC index for efficient latest-first queries.
CREATE INDEX idx_candles_lookup ON candles (pair_id, timeframe, ts DESC);