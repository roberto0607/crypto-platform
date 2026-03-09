"""Scenario Engine — Monte Carlo ghost candle generation.

Generates 500 simulated price paths, clusters into 3 scenarios (Bull, Base, Bear),
and returns predicted OHLC candle shapes for each scenario.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.interpolate import interp1d

from app.models.seasonality import SeasonalityModel

logger = logging.getLogger("ml")

N_SIMULATIONS = 500
SCENARIOS = 3

GHOST_CANDLE_COUNTS: dict[str, int] = {
    "1m": 60, "5m": 48, "15m": 24,
    "1h": 24, "4h": 42, "1d": 14,
}

TF_SECONDS: dict[str, int] = {
    "1m": 60, "5m": 300, "15m": 900,
    "1h": 3600, "4h": 14400, "1d": 86400,
}


@dataclass
class GhostCandle:
    ts: str          # ISO timestamp
    open: float
    high: float
    low: float
    close: float
    confidence: float  # 0-1, decays with horizon


@dataclass
class Scenario:
    name: str               # "bull" | "base" | "bear"
    probability: float      # 0-1
    candles: list[GhostCandle]
    final_price: float
    total_return_pct: float


def generate_scenarios(
    current_price: float,
    current_time: datetime,
    timeframe: str,
    tft_forecast: dict | None,
    regime: str | None,
    regime_confidence: float,
    ensemble_direction: str,
    ensemble_confidence: float,
    seasonality: SeasonalityModel,
    atr_14: float,
    n_candles: int | None = None,
) -> list[Scenario]:
    """Generate 3 scenario paths (bull/base/bear) via Monte Carlo simulation."""

    if n_candles is None:
        n_candles = GHOST_CANDLE_COUNTS.get(timeframe, 24)

    tf_seconds = TF_SECONDS.get(timeframe, 3600)

    # Phase 1: Build interpolated drift curve from TFT forecast
    drift_func, spread_func = _build_drift_functions(
        tft_forecast, n_candles, current_price, atr_14
    )

    # Phase 2: Run Monte Carlo simulations
    simulations = []
    for _ in range(N_SIMULATIONS):
        candles, final_price = _simulate_path(
            current_price, current_time, tf_seconds, n_candles,
            drift_func, spread_func, seasonality, regime, atr_14,
        )
        simulations.append({"candles": candles, "final_price": final_price})

    # Phase 3: Cluster into 3 scenarios
    sorted_sims = sorted(simulations, key=lambda s: s["final_price"])
    n = len(sorted_sims)
    bear_sims = sorted_sims[:n // 3]
    base_sims = sorted_sims[n // 3: 2 * n // 3]
    bull_sims = sorted_sims[2 * n // 3:]

    def median_scenario(sims: list, name: str) -> Scenario:
        median_idx = len(sims) // 2
        median_sim = sims[median_idx]
        total_return = (median_sim["final_price"] - current_price) / current_price * 100
        return Scenario(
            name=name,
            probability=len(sims) / n,
            candles=median_sim["candles"],
            final_price=round(median_sim["final_price"], 2),
            total_return_pct=round(total_return, 2),
        )

    scenarios = [
        median_scenario(bear_sims, "bear"),
        median_scenario(base_sims, "base"),
        median_scenario(bull_sims, "bull"),
    ]

    # Adjust probabilities based on ensemble direction
    if ensemble_direction == "BUY" and ensemble_confidence > 70:
        shift = (ensemble_confidence - 70) / 100 * 0.15
        scenarios[2].probability += shift  # bull up
        scenarios[0].probability -= shift  # bear down
    elif ensemble_direction == "SELL" and ensemble_confidence > 70:
        shift = (ensemble_confidence - 70) / 100 * 0.15
        scenarios[0].probability += shift  # bear up
        scenarios[2].probability -= shift  # bull down

    # Normalize probabilities
    total_prob = sum(s.probability for s in scenarios)
    if total_prob > 0:
        for s in scenarios:
            s.probability = round(s.probability / total_prob, 2)

    return scenarios


def _build_drift_functions(
    tft_forecast: dict | None,
    n_candles: int,
    current_price: float,
    atr_14: float,
) -> tuple:
    """Build interpolated drift and spread functions from TFT forecast."""

    if tft_forecast:
        known_horizons = [0]
        known_returns = [0.0]
        known_spreads = [0.0]

        for key, steps in [("t+1", 1), ("t+3", 3), ("t+6", 6), ("t+12", 12)]:
            if key in tft_forecast:
                h = tft_forecast[key]
                known_horizons.append(steps)
                known_returns.append(float(h.get("p50", 0)))
                known_spreads.append(
                    float(h.get("p90", 0)) - float(h.get("p10", 0))
                )

        if len(known_horizons) >= 3:
            # Extrapolate beyond last known horizon
            if n_candles > known_horizons[-1]:
                last_slope = (known_returns[-1] - known_returns[-2]) / max(
                    known_horizons[-1] - known_horizons[-2], 1
                )
                known_horizons.append(n_candles)
                known_returns.append(
                    known_returns[-1] + last_slope * (n_candles - known_horizons[-2])
                )
                known_spreads.append(known_spreads[-1] * 1.5)

            drift_func = interp1d(
                known_horizons, known_returns,
                kind="linear", fill_value="extrapolate",
            )
            spread_func = interp1d(
                known_horizons, known_spreads,
                kind="linear", fill_value="extrapolate",
            )
            return drift_func, spread_func

    # Fallback: no TFT forecast — use ATR-based random walk
    base_vol = atr_14 / current_price if current_price > 0 else 0.002

    def drift_func(step):
        return 0.0  # No directional bias without TFT

    def spread_func(step):
        return float(base_vol * np.sqrt(max(step, 1)))

    return drift_func, spread_func


def _simulate_path(
    current_price: float,
    current_time: datetime,
    tf_seconds: int,
    n_candles: int,
    drift_func,
    spread_func,
    seasonality: SeasonalityModel,
    regime: str | None,
    atr_14: float,
) -> tuple[list[GhostCandle], float]:
    """Simulate a single price path producing n_candles ghost candles."""

    path = [current_price]
    candles = []
    base_vol = atr_14 / current_price if current_price > 0 else 0.002

    for step in range(n_candles):
        future_time = current_time + timedelta(seconds=tf_seconds * (step + 1))
        hour = future_time.hour
        dow = future_time.weekday()

        profile = seasonality.get_profile(hour, dow)

        # Per-step drift from interpolated curve
        if step == 0:
            base_drift = float(drift_func(1))
        else:
            base_drift = float(drift_func(step + 1)) - float(drift_func(step))

        # Noise from seasonality
        noise_scale = max(profile.std_return, base_vol * 0.5)
        noise = np.random.normal(0, noise_scale)

        # Regime conditioning
        if regime in ("TRENDING_UP", "TRENDING_DOWN"):
            noise *= 0.7
            base_drift *= 1.2
        elif regime == "RANGING":
            reversion = (current_price - path[-1]) / current_price * 0.1
            base_drift += reversion
            noise *= 0.8
        elif regime == "VOLATILE":
            noise *= 1.5

        step_return = base_drift + noise
        new_close = path[-1] * (1 + step_return)

        # Generate candle OHLC shape from seasonality profile
        candle_range = max(
            abs(new_close - path[-1]),
            profile.mean_range_pct * path[-1],
        )
        body_size = candle_range * profile.mean_body_ratio

        is_bullish = new_close > path[-1]

        if is_bullish:
            open_price = new_close - body_size
            high_price = new_close + candle_range * profile.mean_upper_wick_ratio
            low_price = open_price - candle_range * profile.mean_lower_wick_ratio
        else:
            open_price = new_close + body_size
            high_price = open_price + candle_range * profile.mean_upper_wick_ratio
            low_price = new_close - candle_range * profile.mean_lower_wick_ratio

        # Ensure OHLC consistency
        high_price = max(high_price, open_price, new_close)
        low_price = min(low_price, open_price, new_close)

        # Confidence decays with horizon
        horizon_ratio = (step + 1) / n_candles
        confidence = max(0.1, 1.0 - horizon_ratio * 0.8)

        candles.append(GhostCandle(
            ts=future_time.isoformat(),
            open=round(open_price, 2),
            high=round(high_price, 2),
            low=round(low_price, 2),
            close=round(new_close, 2),
            confidence=round(confidence, 3),
        ))
        path.append(new_close)

    return candles, path[-1]


def scenarios_to_dict(scenarios: list[Scenario]) -> list[dict]:
    """Convert scenarios to JSON-serializable dicts."""
    return [
        {
            "name": s.name,
            "probability": s.probability,
            "finalPrice": s.final_price,
            "totalReturnPct": s.total_return_pct,
            "candles": [
                {
                    "ts": c.ts,
                    "open": c.open,
                    "high": c.high,
                    "low": c.low,
                    "close": c.close,
                    "confidence": c.confidence,
                }
                for c in s.candles
            ],
        }
        for s in scenarios
    ]
