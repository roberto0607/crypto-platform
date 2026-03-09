"""Trend indicators: EMA, SMA, ADX, Supertrend."""

import pandas as pd
import numpy as np


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period).mean()


def compute_adx(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    """Average Directional Index — measures trend strength (0-100)."""
    high, low, close = df["high"], df["low"], df["close"]

    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    tr = pd.concat(
        [
            high - low,
            (high - close.shift(1)).abs(),
            (low - close.shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)

    atr = tr.ewm(alpha=1 / period, adjust=False).mean()
    plus_di = 100 * (plus_dm.ewm(alpha=1 / period, adjust=False).mean() / atr)
    minus_di = 100 * (minus_dm.ewm(alpha=1 / period, adjust=False).mean() / atr)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=1 / period, adjust=False).mean()

    df[f"adx_{period}"] = adx
    df["plus_di"] = plus_di
    df["minus_di"] = minus_di

    return df


def compute_supertrend(
    df: pd.DataFrame, period: int = 10, multiplier: float = 3.0
) -> pd.DataFrame:
    """Supertrend — trend-following indicator with direction."""
    hl2 = (df["high"] + df["low"]) / 2
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - df["close"].shift(1)).abs(),
            (df["low"] - df["close"].shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = tr.rolling(window=period).mean()

    upper = hl2 + multiplier * atr
    lower = hl2 - multiplier * atr

    supertrend = pd.Series(np.nan, index=df.index, dtype=float)
    direction = pd.Series(0, index=df.index, dtype=int)

    first_valid = atr.first_valid_index()
    if first_valid is None:
        df["supertrend"] = np.nan
        df["supertrend_dir"] = 0
        return df

    start = first_valid
    supertrend.iloc[start] = upper.iloc[start]
    direction.iloc[start] = -1

    for i in range(start + 1, len(df)):
        if df["close"].iloc[i] > upper.iloc[i - 1]:
            direction.iloc[i] = 1
        elif df["close"].iloc[i] < lower.iloc[i - 1]:
            direction.iloc[i] = -1
        else:
            direction.iloc[i] = direction.iloc[i - 1]

        supertrend.iloc[i] = lower.iloc[i] if direction.iloc[i] == 1 else upper.iloc[i]

    df["supertrend"] = supertrend
    df["supertrend_dir"] = direction

    return df


def compute_trend_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all trend-related features."""
    close = df["close"]

    # EMAs
    for period in [8, 21, 50, 100, 200]:
        df[f"ema_{period}"] = ema(close, period)

    # SMAs
    for period in [20, 50, 200]:
        df[f"sma_{period}"] = sma(close, period)

    # Price vs MAs (normalized distance)
    for period in [21, 50, 200]:
        ma_col = f"ema_{period}"
        df[f"dist_ema_{period}"] = (close - df[ma_col]) / df[ma_col]

    # EMA crossover signals
    df["ema_8_21_cross"] = (df["ema_8"] > df["ema_21"]).astype(int)
    df["ema_50_200_cross"] = (df["ema_50"] > df["ema_200"]).astype(int)

    # ADX (trend strength)
    df = compute_adx(df, 14)

    # Supertrend
    df = compute_supertrend(df, 10, 3.0)

    return df
