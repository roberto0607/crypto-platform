"""Performance degradation alerts.

Monitors model performance metrics and fires alerts when thresholds
are exceeded:
  - Win rate drops below 50% over 7-day window
  - Profit factor drops below 1.0 (losing money)
  - Max drawdown exceeds 15%
  - Model hasn't been retrained in 30+ days
  - Signal frequency drops to 0 (model not generating signals)
"""

import logging
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta

logger = logging.getLogger("ml.alerts")


@dataclass
class Alert:
    """Performance alert."""
    level: str  # "warning" | "critical"
    metric: str
    message: str
    current_value: float | str
    threshold: float | str
    timestamp: str


class AlertChecker:
    """Check model performance metrics against thresholds."""

    def __init__(
        self,
        min_win_rate: float = 0.50,
        min_profit_factor: float = 1.0,
        max_drawdown_pct: float = 15.0,
        max_days_since_retrain: int = 30,
        min_daily_signals: int = 1,
    ):
        self.min_win_rate = min_win_rate
        self.min_profit_factor = min_profit_factor
        self.max_drawdown_pct = max_drawdown_pct
        self.max_days_since_retrain = max_days_since_retrain
        self.min_daily_signals = min_daily_signals

    def check(
        self,
        performance: dict,
        last_retrained: datetime | None = None,
        recent_signal_count: int | None = None,
        window_days: int = 7,
    ) -> list[Alert]:
        """
        Run all alert checks against performance data.

        Args:
            performance: Dict with keys: win_rate, profit_factor,
                         max_drawdown_pct, total_signals.
            last_retrained: When the model was last retrained.
            recent_signal_count: Number of signals in last `window_days`.
            window_days: Rolling window for metrics.

        Returns:
            List of Alert objects (empty if all OK).
        """
        now = datetime.now(timezone.utc)
        alerts: list[Alert] = []

        # Win rate check
        win_rate = performance.get("win_rate", 1.0)
        if win_rate < self.min_win_rate:
            level = "critical" if win_rate < 0.40 else "warning"
            alerts.append(Alert(
                level=level,
                metric="win_rate",
                message=f"Win rate dropped to {win_rate:.1%} (threshold: {self.min_win_rate:.0%})",
                current_value=round(win_rate, 4),
                threshold=self.min_win_rate,
                timestamp=now.isoformat(),
            ))

        # Profit factor check
        pf = performance.get("profit_factor", float("inf"))
        if isinstance(pf, (int, float)) and pf < self.min_profit_factor:
            alerts.append(Alert(
                level="critical",
                metric="profit_factor",
                message=f"Profit factor dropped to {pf:.2f} — model is losing money",
                current_value=round(pf, 2),
                threshold=self.min_profit_factor,
                timestamp=now.isoformat(),
            ))

        # Max drawdown check
        dd = performance.get("max_drawdown_pct", 0)
        if dd > self.max_drawdown_pct:
            alerts.append(Alert(
                level="critical" if dd > 20 else "warning",
                metric="max_drawdown",
                message=f"Max drawdown at {dd:.1f}% (threshold: {self.max_drawdown_pct}%)",
                current_value=round(dd, 2),
                threshold=self.max_drawdown_pct,
                timestamp=now.isoformat(),
            ))

        # Stale model check
        if last_retrained is not None:
            days_since = (now - last_retrained).days
            if days_since > self.max_days_since_retrain:
                alerts.append(Alert(
                    level="warning",
                    metric="model_staleness",
                    message=f"Model hasn't been retrained in {days_since} days",
                    current_value=days_since,
                    threshold=self.max_days_since_retrain,
                    timestamp=now.isoformat(),
                ))

        # Signal frequency check
        if recent_signal_count is not None:
            expected = self.min_daily_signals * window_days
            if recent_signal_count < expected:
                alerts.append(Alert(
                    level="warning" if recent_signal_count > 0 else "critical",
                    metric="signal_frequency",
                    message=(f"Only {recent_signal_count} signals in last {window_days} days "
                             f"(expected ≥ {expected})"),
                    current_value=recent_signal_count,
                    threshold=expected,
                    timestamp=now.isoformat(),
                ))

        return alerts

    def check_from_db_metrics(self, db_metrics: dict) -> list[Alert]:
        """Convenience: check from the aggregate performance API response format."""
        performance = {
            "win_rate": db_metrics.get("winRate", 1.0),
            "profit_factor": db_metrics.get("profitFactor", float("inf")),
            "max_drawdown_pct": db_metrics.get("maxDrawdownPct", 0),
            "total_signals": db_metrics.get("totalSignals", 0),
        }

        last_retrained = None
        if "lastRetrained" in db_metrics and db_metrics["lastRetrained"]:
            try:
                last_retrained = datetime.fromisoformat(db_metrics["lastRetrained"])
            except (ValueError, TypeError):
                pass

        return self.check(
            performance,
            last_retrained=last_retrained,
            recent_signal_count=db_metrics.get("recentSignalCount"),
        )


def format_alerts(alerts: list[Alert]) -> list[dict]:
    """Convert alerts to serializable dicts."""
    return [asdict(a) for a in alerts]
