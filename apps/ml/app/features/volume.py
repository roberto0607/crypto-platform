"""Volume indicators: OBV, Volume SMA, Volume Ratio, VWAP."""

import pandas as pd
import numpy as np


def compute_volume_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all volume-related features."""
    close = df["close"]
    volume = df["volume"]

    # OBV — On-Balance Volume
    direction = np.sign(close.diff()).fillna(0)
    df["obv"] = (direction * volume).cumsum()

    # OBV slope (5-period rate of change)
    df["obv_slope"] = df["obv"].diff(5) / 5

    # Volume SMA (20)
    df["vol_sma_20"] = volume.rolling(window=20).mean()

    # Volume ratio (current / 20-period average)
    df["vol_ratio"] = volume / df["vol_sma_20"].replace(0, 1)

    # VWAP (cumulative, session approximation)
    tp = (df["high"] + df["low"] + close) / 3
    cum_tp_vol = (tp * volume).cumsum()
    cum_vol = volume.cumsum().replace(0, 1)
    df["vwap"] = cum_tp_vol / cum_vol
    df["vwap_dist"] = (close - df["vwap"]) / df["vwap"]

    return df
