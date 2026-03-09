"""Price action features: candle patterns, HH/LL, returns."""

import pandas as pd
import numpy as np


def compute_price_action_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute price action and candle pattern features."""
    close = df["close"]
    open_ = df["open"]
    high = df["high"]
    low = df["low"]

    # Candle body ratio (body / total range)
    body = (close - open_).abs()
    full_range = (high - low).replace(0, np.nan)
    df["body_ratio"] = body / full_range

    # Upper / lower shadow ratios
    candle_top = pd.concat([close, open_], axis=1).max(axis=1)
    candle_bottom = pd.concat([close, open_], axis=1).min(axis=1)
    df["upper_shadow"] = (high - candle_top) / full_range
    df["lower_shadow"] = (candle_bottom - low) / full_range

    # Bullish / bearish candle (1 = green, 0 = red)
    df["is_bullish"] = (close > open_).astype(int)

    # Consecutive up / down candles
    bullish = (close > open_).astype(int)
    groups = (bullish != bullish.shift()).cumsum()
    df["consec_up"] = bullish.groupby(groups).cumsum() * bullish

    bearish = (close < open_).astype(int)
    groups_bear = (bearish != bearish.shift()).cumsum()
    df["consec_down"] = bearish.groupby(groups_bear).cumsum() * bearish

    # Higher highs / Lower lows count (lookback 5)
    lookback = 5
    df["higher_highs"] = sum(
        (high > high.shift(i)).astype(int) for i in range(1, lookback + 1)
    )
    df["lower_lows"] = sum(
        (low < low.shift(i)).astype(int) for i in range(1, lookback + 1)
    )

    # Distance from recent high / low (normalized, 20-period)
    period = 20
    recent_high = high.rolling(window=period).max()
    recent_low = low.rolling(window=period).min()
    df["dist_from_high"] = (close - recent_high) / recent_high
    df["dist_from_low"] = (close - recent_low) / recent_low

    # Lagged returns
    for lag in [1, 3, 5, 10]:
        shifted = close.shift(lag)
        df[f"return_{lag}"] = (close - shifted) / shifted

    return df
