"""Auto-label historical candles with regime labels for training.

Uses a forward-looking approach (OK for training, not for live inference):
  - Look at the next N candles
  - If price moves > threshold in one direction → TRENDING_UP or TRENDING_DOWN
  - If price stays within tight band → RANGING
  - If ATR expands significantly → VOLATILE
  - If regime changes within the window → TRANSITIONING

Labels are strings matching the Regime enum values.
"""

import numpy as np
import pandas as pd

from app.models.regime_detector import detect_regime, MarketRegime


# Map old MarketRegime enum values to new Regime string values
_REGIME_MAP = {
    MarketRegime.TRENDING_UP: "TRENDING_UP",
    MarketRegime.TRENDING_DOWN: "TRENDING_DOWN",
    MarketRegime.RANGING: "RANGING",
    MarketRegime.VOLATILE: "VOLATILE",
    MarketRegime.QUIET: "RANGING",  # Fold QUIET into RANGING
}


def auto_label_regimes(
    df: pd.DataFrame,
    forward_window: int = 20,
    trend_threshold_atr: float = 2.0,
    range_threshold_atr: float = 1.0,
    vol_expansion_threshold: float = 2.0,
) -> np.ndarray:
    """
    Generate regime labels for each row in the DataFrame.

    For rows where we have forward data (i < len - forward_window):
      Uses forward-looking price behavior to label the regime.

    For the last `forward_window` rows:
      Falls back to the heuristic detect_regime() applied at that row.

    Args:
        df: Feature DataFrame from build_feature_matrix().
        forward_window: How many candles ahead to analyze.
        trend_threshold_atr: ATR multiple for trending classification.
        range_threshold_atr: ATR multiple ceiling for ranging.
        vol_expansion_threshold: ATR expansion ratio for volatile.

    Returns:
        Array of regime label strings, same length as df.
    """
    n = len(df)
    labels = np.empty(n, dtype=object)

    close = df["close"].values
    high = df["high"].values
    low = df["low"].values

    # ATR as percentage of price — used as volatility reference
    if "atr_pct" in df.columns:
        atr_pct = df["atr_pct"].values
    elif "atr_14" in df.columns:
        atr_pct = df["atr_14"].values / np.where(close > 0, close, 1.0)
    else:
        # Fallback: simple range-based volatility estimate
        atr_pct = np.full(n, 0.01)

    # Forward-looking labeling
    for i in range(n - forward_window):
        entry = close[i]
        if entry <= 0 or atr_pct[i] <= 0:
            labels[i] = "RANGING"
            continue

        # Forward window slice
        fwd_highs = high[i + 1: i + 1 + forward_window]
        fwd_lows = low[i + 1: i + 1 + forward_window]
        fwd_close = close[i + forward_window]

        # Directional move (signed)
        directional_move = (fwd_close - entry) / entry

        # Range: max high - min low as % of entry
        fwd_range = (fwd_highs.max() - fwd_lows.min()) / entry

        # ATR expansion: compare ATR at end of window vs start
        atr_start = atr_pct[i]
        atr_end = atr_pct[min(i + forward_window, n - 1)]
        atr_expansion = atr_end / atr_start if atr_start > 0 else 1.0

        ref_atr = atr_pct[i]

        # Classification priority:
        # 1. VOLATILE — ATR expanding significantly
        if atr_expansion > vol_expansion_threshold:
            labels[i] = "VOLATILE"
        # 2. TRENDING_UP — strong directional upward move
        elif directional_move > trend_threshold_atr * ref_atr:
            labels[i] = "TRENDING_UP"
        # 3. TRENDING_DOWN — strong directional downward move
        elif directional_move < -trend_threshold_atr * ref_atr:
            labels[i] = "TRENDING_DOWN"
        # 4. RANGING — price contained in tight band
        elif fwd_range < range_threshold_atr * ref_atr:
            labels[i] = "RANGING"
        # 5. TRANSITIONING — none of the above (ambiguous)
        else:
            labels[i] = "TRANSITIONING"

    # Backward-looking fallback for the last `forward_window` rows
    for i in range(max(0, n - forward_window), n):
        try:
            # Use the heuristic detector on a slice ending at row i
            slice_start = max(0, i - 50)
            sub_df = df.iloc[slice_start: i + 1].copy()
            if len(sub_df) < 5:
                labels[i] = "RANGING"
                continue
            regime, _ = detect_regime(sub_df)
            labels[i] = _REGIME_MAP.get(regime, "RANGING")
        except Exception:
            labels[i] = "RANGING"

    return labels


def regime_label_distribution(labels: np.ndarray) -> dict:
    """Get human-readable regime label distribution."""
    unique, counts = np.unique(labels, return_counts=True)
    total = len(labels)
    dist = {}
    for label, count in zip(unique, counts):
        dist[str(label)] = {
            "count": int(count),
            "pct": round(count / total * 100, 1) if total > 0 else 0,
        }
    return {"total": total, "distribution": dist}
