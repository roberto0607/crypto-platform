"""Derivatives features — aggregates funding rate, OI, and L/S ratio snapshots
to candle-aligned features for the ML pipeline.

Features produced per candle window:
  - deriv_funding_rate:     latest funding rate in window
  - deriv_mark_price:       latest mark price
  - deriv_oi:               latest open interest (base asset)
  - deriv_oi_usd:           latest open interest (USD)
  - deriv_oi_change_pct:    mean OI change % across snapshots in window
  - deriv_global_ls_ratio:  latest global long/short ratio
  - deriv_global_long_pct:  latest global long %
  - deriv_top_ls_ratio:     latest top trader L/S ratio
  - deriv_top_long_pct:     latest top trader long %
  - deriv_liq_pressure:     mean liquidation pressure in window
  - deriv_liq_intensity:    max liquidation intensity in window
"""

import pandas as pd
from app.db import get_pool

TIMEFRAME_INTERVALS = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
    "4h": "4 hours",
    "1d": "1 day",
}


async def fetch_derivatives_features(
    pair_id: str,
    timeframe: str = "1h",
    limit: int = 500,
) -> pd.DataFrame:
    """
    Fetch derivatives snapshots from DB and aggregate to match candle timeframe.

    Returns a DataFrame with a 'ts' column and aggregated feature columns.
    Merge with candle DataFrame on 'ts'.
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

            (array_agg(funding_rate::float ORDER BY ts DESC))[1]       AS deriv_funding_rate,
            (array_agg(mark_price::float ORDER BY ts DESC))[1]         AS deriv_mark_price,
            (array_agg(open_interest::float ORDER BY ts DESC))[1]      AS deriv_oi,
            (array_agg(open_interest_usd::float ORDER BY ts DESC))[1]  AS deriv_oi_usd,
            AVG(oi_change_pct::float)                                  AS deriv_oi_change_pct,
            (array_agg(global_ls_ratio::float ORDER BY ts DESC))[1]    AS deriv_global_ls_ratio,
            (array_agg(global_long_pct::float ORDER BY ts DESC))[1]    AS deriv_global_long_pct,
            (array_agg(top_ls_ratio::float ORDER BY ts DESC))[1]       AS deriv_top_ls_ratio,
            (array_agg(top_long_pct::float ORDER BY ts DESC))[1]       AS deriv_top_long_pct,
            AVG(liq_pressure::float)                                   AS deriv_liq_pressure,
            MAX(ABS(liq_intensity::float))                             AS deriv_liq_intensity
        FROM derivatives_snapshots
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

    df = pd.DataFrame([dict(r) for r in rows])
    df.rename(columns={"bucket": "ts"}, inplace=True)
    df["ts"] = pd.to_datetime(df["ts"], utc=True)

    return df
