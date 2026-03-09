"""Feature pipeline orchestrator — combines all indicator modules into a single feature matrix."""

import pandas as pd

from app.db import fetch_candles
from app.features.trend import compute_trend_features
from app.features.momentum import compute_momentum_features
from app.features.volatility import compute_volatility_features
from app.features.volume import compute_volume_features
from app.features.price_action import compute_price_action_features
from app.features.order_flow import fetch_order_flow_features

# Minimum candles needed (indicators need warm-up periods)
MIN_CANDLES = 50

# Base OHLCV columns (not features)
BASE_COLS = {"ts", "open", "high", "low", "close", "volume"}


async def build_feature_matrix(
    pair_id: str,
    timeframe: str = "1h",
    limit: int = 500,
) -> pd.DataFrame:
    """
    Build a complete feature matrix from raw OHLCV data.

    Returns a DataFrame where each row is a candle and columns are features.
    NaN rows from indicator warm-up periods are dropped.
    """
    rows = await fetch_candles(pair_id, timeframe, limit)
    if len(rows) < MIN_CANDLES:
        return pd.DataFrame()

    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df.sort_values("ts").reset_index(drop=True)

    # Compute all feature groups
    df = compute_trend_features(df)
    df = compute_momentum_features(df)
    df = compute_volatility_features(df)
    df = compute_volume_features(df)
    df = compute_price_action_features(df)

    # Calendar features (crypto has time-of-day and day-of-week patterns)
    df["hour_of_day"] = df["ts"].dt.hour
    df["day_of_week"] = df["ts"].dt.dayofweek
    df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)

    # Merge order flow features (from book snapshots, aggregated to candle windows)
    try:
        of_df = await fetch_order_flow_features(pair_id, timeframe, limit)
        if not of_df.empty:
            df = df.merge(of_df, on="ts", how="left")
            # Fill NaN (periods with no order flow data) with neutral values
            of_fill = {
                "of_avg_imbalance": 0,
                "of_max_imbalance": 0,
                "of_avg_weighted_imb": 0,
                "of_avg_depth_ratio": 1,
                "of_avg_spread_bps": 0,
                "of_whale_bid_count": 0,
                "of_whale_ask_count": 0,
                "of_avg_bid_depth_usd": 0,
                "of_avg_ask_depth_usd": 0,
            }
            for col, val in of_fill.items():
                if col in df.columns:
                    df[col] = df[col].fillna(val)
    except Exception:
        pass  # Non-fatal: order flow data may not exist yet

    # Drop rows with NaN (from indicator warm-up periods)
    df = df.dropna().reset_index(drop=True)

    return df


def get_feature_columns(df: pd.DataFrame) -> list[str]:
    """Return only the computed feature column names (excluding base OHLCV + ts)."""
    return [c for c in df.columns if c not in BASE_COLS]


async def build_multi_timeframe_features(
    pair_id: str,
    base_timeframe: str = "1h",
    limit: int = 500,
) -> pd.DataFrame:
    """
    Build features for the base timeframe, enriched with higher-timeframe
    trend context. Higher-TF values are the latest snapshot applied as
    constant columns to all base-TF rows.
    """
    df = await build_feature_matrix(pair_id, base_timeframe, limit)
    if df.empty:
        return df

    # Map each base timeframe to its relevant higher timeframes
    higher_tfs: dict[str, list[str]] = {
        "1m": ["5m", "15m", "1h"],
        "5m": ["15m", "1h", "4h"],
        "15m": ["1h", "4h", "1d"],
        "1h": ["4h", "1d"],
        "4h": ["1d"],
        "1d": [],
    }

    for htf in higher_tfs.get(base_timeframe, []):
        htf_df = await build_feature_matrix(pair_id, htf, 200)
        if htf_df.empty:
            continue

        latest = htf_df.iloc[-1]
        prefix = f"htf_{htf}_"

        # Key higher-TF signals
        if "rsi_14" in htf_df.columns:
            df[f"{prefix}rsi"] = float(latest["rsi_14"])
        if "adx_14" in htf_df.columns:
            df[f"{prefix}adx"] = float(latest["adx_14"])
        if "ema_50" in htf_df.columns:
            df[f"{prefix}trend"] = 1 if latest["close"] > latest["ema_50"] else -1
        if "bb_width" in htf_df.columns:
            df[f"{prefix}bb_width"] = float(latest["bb_width"])
        if "macd_hist" in htf_df.columns:
            df[f"{prefix}macd_hist"] = float(latest["macd_hist"])
        if "supertrend_dir" in htf_df.columns:
            df[f"{prefix}supertrend"] = int(latest["supertrend_dir"])

    return df
