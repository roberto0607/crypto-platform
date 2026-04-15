"""cycle.py — halving-cycle position + Bitcoin Power Law fair value."""

from datetime import datetime
from typing import List, Tuple

import numpy as np

# Known halving dates + estimated next halving
HALVINGS: List[datetime] = [
    datetime(2012, 11, 28),  # H1: 50 → 25
    datetime(2016, 7, 9),    # H2: 25 → 12.5
    datetime(2020, 5, 11),   # H3: 12.5 → 6.25
    datetime(2024, 4, 19),   # H4: 6.25 → 3.125
    datetime(2028, 3, 1),    # H5: estimated
]

GENESIS = datetime(2009, 1, 3)


def get_cycle_position(today: datetime) -> dict:
    """Current halving-cycle position.

    Returns phase + days elapsed + cycle number + next halving date.
    """
    last_halving = max(h for h in HALVINGS if h <= today)
    next_halving = min(h for h in HALVINGS if h > today)

    days_since_halving = (today - last_halving).days
    cycle_length = (next_halving - last_halving).days or 1
    cycle_pct = days_since_halving / cycle_length
    cycle_number = HALVINGS.index(last_halving) + 1

    if cycle_pct < 0.25:
        phase, phase_color = "ACCUMULATION", "#6B7280"
    elif cycle_pct < 0.50:
        phase, phase_color = "EARLY BULL", "#10B981"
    elif cycle_pct < 0.75:
        phase, phase_color = "PARABOLIC BULL", "#F59E0B"
    else:
        phase, phase_color = "DISTRIBUTION", "#EF4444"

    return {
        "daysSinceHalving": days_since_halving,
        "daysToNextHalving": (next_halving - today).days,
        "cycleNumber": cycle_number,
        "cyclePercent": round(cycle_pct * 100, 1),
        "phase": phase,
        "phaseColor": phase_color,
        "lastHalvingDate": last_halving.isoformat(),
        "nextHalvingDate": next_halving.isoformat(),
    }


def get_power_law_position(
    current_price: float,
    historical_prices: List[Tuple[datetime, float]],
) -> dict:
    """Log-log regression on (days-since-genesis, price) → fair value + corridor.

    Floor / ceiling are ±2σ of regression residuals in log-space.
    """
    if not historical_prices or current_price <= 0:
        return _empty_power_law()

    today = datetime.utcnow()
    days_list = [max(1, (d - GENESIS).days) for d, _ in historical_prices]
    prices_list = [p for _, p in historical_prices]

    days = np.array(days_list, dtype=float)
    prices = np.array(prices_list, dtype=float)
    mask = prices > 0
    days, prices = days[mask], prices[mask]
    if days.size < 2:
        return _empty_power_law()

    log_days = np.log(days)
    log_prices = np.log(prices)
    a, b = np.polyfit(log_days, log_prices, 1)

    fitted = np.exp(b) * days ** a
    residuals = log_prices - np.log(np.maximum(fitted, 1e-9))
    std = float(np.std(residuals))

    current_days = max(1, (today - GENESIS).days)
    fair_value = float(np.exp(b) * current_days ** a)
    floor = fair_value * float(np.exp(-2 * std))
    ceiling = fair_value * float(np.exp(2 * std))

    if ceiling <= floor:
        corridor_pct = 50.0
    else:
        log_position = (np.log(current_price) - np.log(floor)) / (
            np.log(ceiling) - np.log(floor)
        )
        corridor_pct = float(max(0.0, min(100.0, log_position * 100)))

    if corridor_pct < 25:
        interpretation = "UNDERVALUED"
    elif corridor_pct < 60:
        interpretation = "FAIR VALUE"
    elif corridor_pct < 85:
        interpretation = "OVERVALUED"
    else:
        interpretation = "EXTREME OVERVALUATION"

    return {
        "fairValue": round(fair_value),
        "floorValue": round(floor),
        "ceilingValue": round(ceiling),
        "corridorPercent": round(corridor_pct, 1),
        "interpretation": interpretation,
    }


def _empty_power_law() -> dict:
    return {
        "fairValue": 0,
        "floorValue": 0,
        "ceilingValue": 0,
        "corridorPercent": 0.0,
        "interpretation": "UNKNOWN",
    }
