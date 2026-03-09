"""Backtesting engine — simulates trading with model signals on historical data.

Tracks key performance metrics:
- Win rate (% of signals that hit TP1 before SL)
- Profit factor (gross profit / gross loss)
- TP1/TP2/TP3 hit rates
- Signal frequency (signals per day)
- Max drawdown
"""

import numpy as np
import pandas as pd

from app.models.xgboost_model import XGBoostModel, CLASS_NAMES
from app.models.signal_generator import TP1_MULT, TP2_MULT, TP3_MULT, SL_MULT


def run_backtest(
    model: XGBoostModel,
    df: pd.DataFrame,
    X: np.ndarray,
    feature_names: list[str],
    min_confidence: float = 70.0,
    forward_window: int = 10,
) -> dict:
    """
    Run a backtest: for each row, get the model's prediction,
    generate a signal if confidence is high enough, then simulate
    whether TP1/TP2/TP3 or SL would have been hit in the next
    `forward_window` candles.

    Args:
        model: Trained XGBoostModel.
        df: Original DataFrame with OHLCV + indicators.
        X: Feature matrix (matching df rows after NaN drop).
        feature_names: Feature column names.
        min_confidence: Minimum confidence to count as a signal.
        forward_window: How many candles to look ahead for TP/SL.

    Returns:
        Backtest results dict with all metrics.
    """
    n = len(X)
    close = df["close"].values
    high = df["high"].values
    low = df["low"].values
    atr = df["atr_14"].values

    # Align: X may be shorter than df due to NaN drop.
    # Use the last n rows of df for alignment.
    offset = len(df) - n

    signals = []
    outcomes = []

    for i in range(n - forward_window):
        # Get prediction
        row = X[i : i + 1]
        pred = model.predict(row)
        if isinstance(pred, list):
            pred = pred[0]

        direction = pred["direction"]
        confidence = pred["confidence"]

        # Skip if below threshold or neutral
        if confidence < min_confidence or direction == "NEUTRAL":
            continue

        df_idx = offset + i
        entry_price = close[df_idx]
        current_atr = atr[df_idx]

        if current_atr <= 0 or np.isnan(current_atr):
            continue

        # Calculate TP/SL levels
        if direction == "BUY":
            tp1 = entry_price + TP1_MULT * current_atr
            tp2 = entry_price + TP2_MULT * current_atr
            tp3 = entry_price + TP3_MULT * current_atr
            sl = entry_price - SL_MULT * current_atr
        else:  # SELL
            tp1 = entry_price - TP1_MULT * current_atr
            tp2 = entry_price - TP2_MULT * current_atr
            tp3 = entry_price - TP3_MULT * current_atr
            sl = entry_price + SL_MULT * current_atr

        # Simulate: check future candles for TP/SL hits
        tp1_hit = False
        tp2_hit = False
        tp3_hit = False
        sl_hit = False

        for j in range(1, forward_window + 1):
            future_idx = df_idx + j
            if future_idx >= len(df):
                break

            fh = high[future_idx]
            fl = low[future_idx]

            if direction == "BUY":
                if fh >= tp1:
                    tp1_hit = True
                if fh >= tp2:
                    tp2_hit = True
                if fh >= tp3:
                    tp3_hit = True
                if fl <= sl:
                    sl_hit = True
            else:  # SELL
                if fl <= tp1:
                    tp1_hit = True
                if fl <= tp2:
                    tp2_hit = True
                if fl <= tp3:
                    tp3_hit = True
                if fh >= sl:
                    sl_hit = True

        # Determine outcome
        if tp1_hit and not sl_hit:
            outcome = "win"
        elif sl_hit and not tp1_hit:
            outcome = "loss"
        elif tp1_hit and sl_hit:
            # Both hit — pessimistic: count as loss (SL likely hit first in volatile markets)
            outcome = "loss"
        else:
            outcome = "expired"  # Neither TP1 nor SL hit within window

        # Calculate P&L based on best outcome
        if direction == "BUY":
            if tp3_hit and not sl_hit:
                pnl_pct = (tp3 - entry_price) / entry_price
            elif tp2_hit and not sl_hit:
                pnl_pct = (tp2 - entry_price) / entry_price
            elif tp1_hit and not sl_hit:
                pnl_pct = (tp1 - entry_price) / entry_price
            elif sl_hit:
                pnl_pct = (sl - entry_price) / entry_price
            else:
                # Expired — use closing price at end of window
                exit_idx = min(df_idx + forward_window, len(df) - 1)
                pnl_pct = (close[exit_idx] - entry_price) / entry_price
        else:  # SELL
            if tp3_hit and not sl_hit:
                pnl_pct = (entry_price - tp3) / entry_price
            elif tp2_hit and not sl_hit:
                pnl_pct = (entry_price - tp2) / entry_price
            elif tp1_hit and not sl_hit:
                pnl_pct = (entry_price - tp1) / entry_price
            elif sl_hit:
                pnl_pct = (entry_price - sl) / entry_price
            else:
                exit_idx = min(df_idx + forward_window, len(df) - 1)
                pnl_pct = (entry_price - close[exit_idx]) / entry_price

        signals.append(
            {
                "idx": i,
                "direction": direction,
                "confidence": confidence,
                "entry_price": entry_price,
            }
        )
        outcomes.append(
            {
                "outcome": outcome,
                "tp1_hit": tp1_hit,
                "tp2_hit": tp2_hit,
                "tp3_hit": tp3_hit,
                "sl_hit": sl_hit,
                "pnl_pct": pnl_pct,
            }
        )

    # Compile metrics
    return _compile_metrics(signals, outcomes, len(df))


def _compile_metrics(
    signals: list[dict], outcomes: list[dict], total_candles: int
) -> dict:
    """Compute aggregate performance metrics from signal outcomes."""
    n = len(signals)
    if n == 0:
        return {
            "total_signals": 0,
            "error": "No signals generated (confidence threshold too high?)",
        }

    wins = sum(1 for o in outcomes if o["outcome"] == "win")
    losses = sum(1 for o in outcomes if o["outcome"] == "loss")
    expired = sum(1 for o in outcomes if o["outcome"] == "expired")

    tp1_hits = sum(1 for o in outcomes if o["tp1_hit"] and not o["sl_hit"])
    tp2_hits = sum(1 for o in outcomes if o["tp2_hit"] and not o["sl_hit"])
    tp3_hits = sum(1 for o in outcomes if o["tp3_hit"] and not o["sl_hit"])

    pnls = [o["pnl_pct"] for o in outcomes]
    gross_profit = sum(p for p in pnls if p > 0)
    gross_loss = abs(sum(p for p in pnls if p < 0))

    profit_factor = (
        round(gross_profit / gross_loss, 2) if gross_loss > 0 else float("inf")
    )

    # Sharpe ratio (annualized, assuming 1h candles)
    pnl_arr = np.array(pnls)
    mean_ret = pnl_arr.mean()
    std_ret = pnl_arr.std()
    sharpe = round(float(mean_ret / std_ret * np.sqrt(252 * 24)), 2) if std_ret > 0 else 0

    # Max drawdown
    cum_pnl = np.cumsum(pnl_arr)
    running_max = np.maximum.accumulate(cum_pnl)
    drawdown = running_max - cum_pnl
    max_drawdown = round(float(drawdown.max()) * 100, 2) if len(drawdown) > 0 else 0

    # Signal frequency
    buy_count = sum(1 for s in signals if s["direction"] == "BUY")
    sell_count = sum(1 for s in signals if s["direction"] == "SELL")

    # Confidence distribution
    confidences = [s["confidence"] for s in signals]

    return {
        "total_signals": n,
        "total_candles": total_candles,
        "buy_signals": buy_count,
        "sell_signals": sell_count,
        "wins": wins,
        "losses": losses,
        "expired": expired,
        "win_rate": round(wins / max(wins + losses, 1), 4),
        "tp1_hit_rate": round(tp1_hits / n, 4),
        "tp2_hit_rate": round(tp2_hits / n, 4),
        "tp3_hit_rate": round(tp3_hits / n, 4),
        "profit_factor": profit_factor,
        "sharpe_ratio": sharpe,
        "max_drawdown_pct": max_drawdown,
        "total_return_pct": round(float(cum_pnl[-1]) * 100, 2) if len(cum_pnl) > 0 else 0,
        "avg_confidence": round(sum(confidences) / len(confidences), 1),
        "avg_pnl_pct": round(float(pnl_arr.mean()) * 100, 4),
    }
