"""Volatility indicators: ATR, Bollinger Bands, Keltner Channels, Squeeze."""

import pandas as pd
import numpy as np


def compute_volatility_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all volatility-related features."""
    close = df["close"]
    high = df["high"]
    low = df["low"]

    # True Range
    tr = pd.concat(
        [
            high - low,
            (high - close.shift(1)).abs(),
            (low - close.shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)

    # ATR (14) — Average True Range (Wilder smoothing)
    period = 14
    df["atr_14"] = tr.ewm(alpha=1 / period, adjust=False).mean()
    df["atr_pct"] = df["atr_14"] / close  # ATR as % of price

    # Bollinger Bands (20, 2σ)
    bb_period = 20
    std_mult = 2.0
    sma_20 = close.rolling(window=bb_period).mean()
    std_20 = close.rolling(window=bb_period).std()
    df["bb_upper"] = sma_20 + std_mult * std_20
    df["bb_lower"] = sma_20 - std_mult * std_20
    df["bb_mid"] = sma_20
    df["bb_width"] = (df["bb_upper"] - df["bb_lower"]) / sma_20
    bb_range = (df["bb_upper"] - df["bb_lower"]).replace(0, np.nan)
    df["bb_pct_b"] = (close - df["bb_lower"]) / bb_range

    # Keltner Channels (20, 1.5×ATR)
    kelt_period = 20
    kelt_mult = 1.5
    ema_20 = close.ewm(span=kelt_period, adjust=False).mean()
    df["kelt_upper"] = ema_20 + kelt_mult * df["atr_14"]
    df["kelt_lower"] = ema_20 - kelt_mult * df["atr_14"]

    # Squeeze detection (Bollinger inside Keltner = low volatility compression)
    df["squeeze"] = (
        (df["bb_lower"] > df["kelt_lower"]) & (df["bb_upper"] < df["kelt_upper"])
    ).astype(int)

    # Historical Volatility (20-period, annualized)
    hv_period = 20
    log_ret = np.log(close / close.shift(1))
    df["hist_vol_20"] = log_ret.rolling(window=hv_period).std() * np.sqrt(252)

    return df
