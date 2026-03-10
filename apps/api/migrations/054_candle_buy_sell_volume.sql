-- Add buy/sell volume tracking for CVD (Cumulative Volume Delta)
ALTER TABLE candles ADD COLUMN IF NOT EXISTS buy_volume NUMERIC(30,10) NOT NULL DEFAULT 0;
ALTER TABLE candles ADD COLUMN IF NOT EXISTS sell_volume NUMERIC(30,10) NOT NULL DEFAULT 0;
