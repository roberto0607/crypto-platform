"""Order flow features — aggregates book snapshots to candle-aligned features.

Reads from `order_flow_snapshots` table (populated by the Node.js snapshot job
every 60s) and aggregates into per-candle features that can be merged with the
main feature matrix.

Features produced per candle window:
  - of_avg_imbalance:      mean bid/ask imbalance
  - of_max_imbalance:      peak imbalance (strongest directional pressure)
  - of_avg_weighted_imb:   mean weighted imbalance (distance-adjusted)
  - of_avg_depth_ratio:    mean bid/ask depth ratio
  - of_avg_spread_bps:     mean spread in basis points
  - of_whale_bid_count:    number of snapshots with large bid detected
  - of_whale_ask_count:    number of snapshots with large ask detected
  - of_avg_bid_depth_usd:  mean bid depth in USD
  - of_avg_ask_depth_usd:  mean ask depth in USD
"""

import pandas as pd
from app.db import get_pool


# Timeframe → PostgreSQL interval for time_bucket grouping
TIMEFRAME_INTERVALS = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
    "4h": "4 hours",
    "1d": "1 day",
}


async def fetch_order_flow_features(
    pair_id: str,
    timeframe: str = "1h",
    limit: int = 500,
) -> pd.DataFrame:
    """
    Fetch order flow snapshots from DB and aggregate to match candle timeframe.

    Returns a DataFrame with a 'ts' column (truncated to candle boundary) and
    aggregated order flow feature columns. Merge with candle DataFrame on 'ts'.
    """
    interval = TIMEFRAME_INTERVALS.get(timeframe)
    if not interval:
        return pd.DataFrame()

    pool = await get_pool()

    rows = await pool.fetch(
        f"""
        SELECT
            date_trunc('hour', ts)
                + (EXTRACT(EPOCH FROM ts - date_trunc('hour', ts))::int
                   / EXTRACT(EPOCH FROM interval '{interval}')::int)
                * interval '{interval}' AS bucket,
            AVG(bid_ask_imbalance::float)     AS of_avg_imbalance,
            MAX(ABS(bid_ask_imbalance::float)) AS of_max_imbalance,
            AVG(weighted_imbalance::float)    AS of_avg_weighted_imb,
            AVG(depth_ratio::float)           AS of_avg_depth_ratio,
            AVG(spread_bps::float)            AS of_avg_spread_bps,
            SUM(CASE WHEN large_order_bid THEN 1 ELSE 0 END) AS of_whale_bid_count,
            SUM(CASE WHEN large_order_ask THEN 1 ELSE 0 END) AS of_whale_ask_count,
            AVG(bid_depth_usd::float)         AS of_avg_bid_depth_usd,
            AVG(ask_depth_usd::float)         AS of_avg_ask_depth_usd
        FROM order_flow_snapshots
        WHERE pair_id = $1
          AND ts >= now() - ($2::int * interval '{interval}')
        GROUP BY bucket
        ORDER BY bucket ASC
        """,
        pair_id,
        limit,
    )

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(
        [dict(r) for r in rows],
    )
    df.rename(columns={"bucket": "ts"}, inplace=True)
    df["ts"] = pd.to_datetime(df["ts"], utc=True)

    return df
