-- Order flow snapshots for ML training (1-minute intervals)
CREATE TABLE order_flow_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id         UUID NOT NULL REFERENCES trading_pairs(id),
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),

    bid_ask_imbalance    NUMERIC(8,4),
    weighted_imbalance   NUMERIC(8,4),
    top_level_imbalance  NUMERIC(8,4),
    bid_depth_usd        NUMERIC(16,2),
    ask_depth_usd        NUMERIC(16,2),
    depth_ratio          NUMERIC(8,4),
    spread_bps           NUMERIC(8,2),
    large_order_bid      BOOLEAN DEFAULT false,
    large_order_ask      BOOLEAN DEFAULT false,
    max_bid_size         NUMERIC(20,8),
    max_ask_size         NUMERIC(20,8),
    bid_wall_price       NUMERIC(20,8),
    ask_wall_price       NUMERIC(20,8)
);

CREATE INDEX idx_oflow_pair_ts ON order_flow_snapshots (pair_id, ts DESC);
