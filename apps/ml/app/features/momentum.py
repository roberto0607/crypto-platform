"""Momentum indicators: RSI, Stoch RSI, MACD, ROC, Williams %R, CCI, MFI."""

import pandas as pd
import numpy as np


def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Relative Strength Index (Wilder smoothing)."""
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)

    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def compute_stoch_rsi(
    series: pd.Series,
    rsi_period: int = 14,
    k_period: int = 3,
    d_period: int = 3,
) -> tuple[pd.Series, pd.Series]:
    """Stochastic RSI — RSI of RSI, bounded 0-100."""
    rsi = compute_rsi(series, rsi_period)
    rsi_min = rsi.rolling(window=rsi_period).min()
    rsi_max = rsi.rolling(window=rsi_period).max()

    stoch_rsi = (rsi - rsi_min) / (rsi_max - rsi_min).replace(0, np.nan)
    k = stoch_rsi.rolling(window=k_period).mean() * 100
    d = k.rolling(window=d_period).mean()

    return k, d


def compute_macd(
    series: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """MACD — trend-following momentum indicator."""
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()

    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line

    return macd_line, signal_line, histogram


def compute_momentum_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all momentum-related features."""
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    # RSI (14)
    df["rsi_14"] = compute_rsi(close, 14)

    # Stochastic RSI
    df["stoch_rsi_k"], df["stoch_rsi_d"] = compute_stoch_rsi(close, 14, 3, 3)

    # MACD (12, 26, 9)
    df["macd"], df["macd_signal"], df["macd_hist"] = compute_macd(close, 12, 26, 9)
    df["macd_cross"] = (df["macd"] > df["macd_signal"]).astype(int)

    # Rate of Change
    for period in [10, 20]:
        shifted = close.shift(period)
        df[f"roc_{period}"] = (close - shifted) / shifted * 100

    # Williams %R (14)
    period = 14
    hh = high.rolling(window=period).max()
    ll = low.rolling(window=period).min()
    df["williams_r"] = -100 * (hh - close) / (hh - ll).replace(0, np.nan)

    # CCI — Commodity Channel Index (20)
    period = 20
    tp = (high + low + close) / 3
    tp_sma = tp.rolling(window=period).mean()
    tp_mad = tp.rolling(window=period).apply(
        lambda x: np.abs(x - x.mean()).mean(), raw=True
    )
    df["cci_20"] = (tp - tp_sma) / (0.015 * tp_mad).replace(0, np.nan)

    # MFI — Money Flow Index (14)
    period = 14
    tp = (high + low + close) / 3
    mf = tp * volume
    pos_mf = mf.where(tp > tp.shift(1), 0).rolling(window=period).sum()
    neg_mf = mf.where(tp <= tp.shift(1), 0).rolling(window=period).sum()
    mfi = 100 - (100 / (1 + pos_mf / neg_mf.replace(0, np.nan)))
    df["mfi_14"] = mfi

    return df
