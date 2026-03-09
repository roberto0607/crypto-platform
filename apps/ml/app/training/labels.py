"""Label generation for supervised learning.

Creates training labels from future price movement. For each candle,
looks N candles ahead and classifies as BUY / SELL / NEUTRAL based on
whether the price moved more than a volatility-adaptive threshold.

Labels:
   1 = BUY  (price went up ≥ threshold)
  -1 = SELL (price went down ≥ threshold)
   0 = NEUTRAL (price stayed within threshold)
"""

import numpy as np
import pandas as pd


def generate_labels(
    df: pd.DataFrame,
    forward_window: int = 10,
    atr_multiplier: float = 1.0,
) -> pd.Series:
    """
    Generate direction labels based on future returns vs ATR threshold.

    Args:
        df: DataFrame with 'close' and 'atr_14' columns.
        forward_window: How many candles ahead to measure the move.
        atr_multiplier: Threshold = atr_multiplier × ATR_14.

    Returns:
        Series of labels: 1 (BUY), -1 (SELL), 0 (NEUTRAL).
        Last `forward_window` rows will be NaN (no future data).
    """
    close = df["close"]
    atr = df["atr_14"]

    # Future return: max gain and max loss within the forward window
    future_max = close.rolling(window=forward_window).max().shift(-forward_window)
    future_min = close.rolling(window=forward_window).min().shift(-forward_window)

    max_gain = (future_max - close) / close
    max_loss = (close - future_min) / close

    # Threshold: adaptive based on current volatility
    threshold = atr_multiplier * atr / close

    labels = pd.Series(0, index=df.index, dtype=int)

    # BUY if max gain exceeds threshold before max loss does
    # (simplified: if max_gain > threshold and max_gain > max_loss)
    buy_mask = (max_gain >= threshold) & (max_gain >= max_loss)
    sell_mask = (max_loss >= threshold) & (max_loss > max_gain)

    labels[buy_mask] = 1
    labels[sell_mask] = -1

    # NaN out the last rows where we can't see the future
    labels.iloc[-forward_window:] = np.nan

    return labels


def generate_magnitude_labels(
    df: pd.DataFrame,
    forward_window: int = 10,
) -> pd.Series:
    """
    Generate continuous magnitude labels (future return %).
    Used for TP zone calibration rather than direction prediction.
    """
    close = df["close"]
    future_close = close.shift(-forward_window)
    magnitude = (future_close - close) / close
    return magnitude


def label_distribution(labels: pd.Series) -> dict:
    """Get human-readable label distribution."""
    clean = labels.dropna()
    total = len(clean)
    if total == 0:
        return {"total": 0, "buy": 0, "sell": 0, "neutral": 0}

    buy_count = int((clean == 1).sum())
    sell_count = int((clean == -1).sum())
    neutral_count = int((clean == 0).sum())

    return {
        "total": total,
        "buy": buy_count,
        "sell": sell_count,
        "neutral": neutral_count,
        "buy_pct": round(buy_count / total * 100, 1),
        "sell_pct": round(sell_count / total * 100, 1),
        "neutral_pct": round(neutral_count / total * 100, 1),
    }
