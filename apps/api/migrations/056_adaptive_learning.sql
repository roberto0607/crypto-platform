-- Phase 4: Adaptive learning system tables

CREATE TABLE IF NOT EXISTS signal_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  btc_price NUMERIC(12,2) NOT NULL,
  action VARCHAR(30) NOT NULL,
  score NUMERIC(6,4) NOT NULL,
  score_label VARCHAR(20) NOT NULL,
  regime VARCHAR(20) NOT NULL,
  regime_confidence NUMERIC(4,3) NOT NULL,
  basis_score NUMERIC(6,4),
  orderbook_score NUMERIC(6,4),
  macro_score NUMERIC(6,4),
  gamma_score NUMERIC(6,4),
  onchain_score NUMERIC(6,4),
  convergence VARCHAR(10),
  streams_agreeing INTEGER,
  weights_used JSONB,
  outcome_30m VARCHAR(10) DEFAULT NULL,
  outcome_1h VARCHAR(10) DEFAULT NULL,
  outcome_4h VARCHAR(10) DEFAULT NULL,
  price_30m NUMERIC(12,2) DEFAULT NULL,
  price_1h NUMERIC(12,2) DEFAULT NULL,
  price_4h NUMERIC(12,2) DEFAULT NULL,
  graded_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS stream_performance (
  id SERIAL PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stream_name VARCHAR(20) NOT NULL,
  regime VARCHAR(20) NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  accuracy_30m NUMERIC(5,4) DEFAULT NULL,
  accuracy_1h NUMERIC(5,4) DEFAULT NULL,
  accuracy_4h NUMERIC(5,4) DEFAULT NULL,
  avg_score_when_correct NUMERIC(6,4) DEFAULT NULL,
  avg_score_when_wrong NUMERIC(6,4) DEFAULT NULL,
  learned_weight NUMERIC(6,4) NOT NULL DEFAULT 0.20,
  last_10_outcomes VARCHAR(10)[] DEFAULT '{}',
  UNIQUE(stream_name, regime)
);

CREATE TABLE IF NOT EXISTS regime_performance (
  id SERIAL PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  regime VARCHAR(20) NOT NULL UNIQUE,
  total_signals INTEGER DEFAULT 0,
  correct_direction_30m INTEGER DEFAULT 0,
  correct_direction_1h INTEGER DEFAULT 0,
  correct_direction_4h INTEGER DEFAULT 0,
  accuracy_1h NUMERIC(5,4) DEFAULT NULL,
  avg_confidence NUMERIC(5,4) DEFAULT NULL
);
