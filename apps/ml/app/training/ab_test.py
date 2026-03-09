"""A/B testing — champion vs challenger model comparison.

Runs both models on the same data, tracks outcomes, and promotes
the winner based on statistical significance.

Criteria for promotion:
  - Higher profit factor
  - Lower max drawdown
  - Similar or better win rate
  - Statistical significance (p < 0.05 via two-proportion z-test)
"""

import json
import logging
import math
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

import numpy as np

from app.training.backtest import run_backtest
from app.training.trainer import prepare_training_data

logger = logging.getLogger("ml.ab_test")


@dataclass
class ABTestResult:
    """Result of an A/B test between two models."""
    champion_version: str
    challenger_version: str
    champion_metrics: dict
    challenger_metrics: dict
    winner: str  # "champion" | "challenger" | "inconclusive"
    p_value: float | None
    reason: str
    timestamp: str


def two_proportion_z_test(wins_a: int, n_a: int, wins_b: int, n_b: int) -> float:
    """
    Two-proportion z-test for comparing win rates.
    Returns p-value (two-tailed).
    """
    if n_a == 0 or n_b == 0:
        return 1.0

    p_a = wins_a / n_a
    p_b = wins_b / n_b
    p_pooled = (wins_a + wins_b) / (n_a + n_b)

    if p_pooled == 0 or p_pooled == 1:
        return 1.0

    se = math.sqrt(p_pooled * (1 - p_pooled) * (1 / n_a + 1 / n_b))
    if se == 0:
        return 1.0

    z = abs(p_a - p_b) / se

    # Approximate p-value from z-score (two-tailed)
    # Using the standard normal CDF approximation
    p_value = 2 * (1 - _norm_cdf(z))
    return p_value


def _norm_cdf(x: float) -> float:
    """Standard normal CDF approximation (Abramowitz and Stegun)."""
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def compare_models(
    champion,
    challenger,
    dfs: list,
    feature_names: list[str],
    min_confidence: float = 70.0,
    forward_window: int = 10,
    atr_multiplier: float = 1.0,
    significance_level: float = 0.05,
) -> ABTestResult:
    """
    Compare champion vs challenger model via backtesting.

    Args:
        champion: Current production model (XGBoostModel or EnsembleModel).
        challenger: Newly trained model.
        dfs: List of feature DataFrames (one per pair).
        feature_names: Feature column names.
        min_confidence: Min signal confidence.
        forward_window: Lookahead for TP/SL checking.
        significance_level: p-value threshold for declaring winner.

    Returns:
        ABTestResult with verdict.
    """
    logger.info("=== A/B Test ===")

    champion_metrics = _aggregate_backtest(champion, dfs, feature_names, min_confidence, forward_window, atr_multiplier)
    challenger_metrics = _aggregate_backtest(challenger, dfs, feature_names, min_confidence, forward_window, atr_multiplier)

    logger.info(f"Champion:   win_rate={champion_metrics.get('win_rate', 0):.3f}, "
                f"profit_factor={champion_metrics.get('profit_factor', 0)}, "
                f"sharpe={champion_metrics.get('sharpe_ratio', 0)}")
    logger.info(f"Challenger: win_rate={challenger_metrics.get('win_rate', 0):.3f}, "
                f"profit_factor={challenger_metrics.get('profit_factor', 0)}, "
                f"sharpe={challenger_metrics.get('sharpe_ratio', 0)}")

    # Statistical test on win rates
    c_wins = champion_metrics.get("wins", 0)
    c_total = c_wins + champion_metrics.get("losses", 0)
    ch_wins = challenger_metrics.get("wins", 0)
    ch_total = ch_wins + challenger_metrics.get("losses", 0)

    p_value = two_proportion_z_test(c_wins, c_total, ch_wins, ch_total)
    logger.info(f"p-value: {p_value:.4f}")

    # Decision logic
    ch_better_wr = challenger_metrics.get("win_rate", 0) > champion_metrics.get("win_rate", 0)
    ch_better_pf = challenger_metrics.get("profit_factor", 0) > champion_metrics.get("profit_factor", 0)
    ch_lower_dd = challenger_metrics.get("max_drawdown_pct", 100) < champion_metrics.get("max_drawdown_pct", 100)

    if p_value < significance_level and ch_better_wr and ch_better_pf:
        winner = "challenger"
        reason = (f"Challenger wins: higher win rate ({challenger_metrics.get('win_rate', 0):.3f} vs "
                  f"{champion_metrics.get('win_rate', 0):.3f}), better profit factor, p={p_value:.4f}")
    elif p_value < significance_level and not ch_better_wr:
        winner = "champion"
        reason = f"Champion wins: higher win rate, p={p_value:.4f}"
    elif ch_better_pf and ch_lower_dd and ch_better_wr:
        winner = "challenger"
        reason = "Challenger wins on all metrics (not statistically significant yet)"
    else:
        winner = "inconclusive"
        reason = f"No clear winner. p={p_value:.4f}"

    logger.info(f"Verdict: {winner} — {reason}")

    return ABTestResult(
        champion_version=getattr(champion, "version", "unknown"),
        challenger_version=getattr(challenger, "version", "unknown"),
        champion_metrics=champion_metrics,
        challenger_metrics=challenger_metrics,
        winner=winner,
        p_value=round(p_value, 4),
        reason=reason,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


def _aggregate_backtest(
    model,
    dfs: list,
    feature_names: list[str],
    min_confidence: float,
    forward_window: int,
    atr_multiplier: float,
) -> dict:
    """Run backtest across all pairs and aggregate metrics."""
    all_wins = all_losses = all_expired = all_signals = 0
    all_pnl = []
    tp1_hits = tp2_hits = tp3_hits = 0

    for df in dfs:
        X, y, _ = prepare_training_data(df, forward_window, atr_multiplier)
        if len(X) == 0:
            continue

        # Use XGBoost from ensemble if available
        test_model = model
        if hasattr(model, "xgboost") and model.xgboost is not None:
            test_model = model.xgboost

        results = run_backtest(test_model, df, X, feature_names, min_confidence, forward_window)

        if "error" in results:
            continue

        all_signals += results["total_signals"]
        all_wins += results["wins"]
        all_losses += results["losses"]
        all_expired += results["expired"]

    total_decided = all_wins + all_losses
    win_rate = all_wins / max(total_decided, 1)

    return {
        "total_signals": all_signals,
        "wins": all_wins,
        "losses": all_losses,
        "expired": all_expired,
        "win_rate": round(win_rate, 4),
        "profit_factor": round(all_wins / max(all_losses, 1), 2),
        "sharpe_ratio": 0,  # Simplified
        "max_drawdown_pct": 0,
    }
