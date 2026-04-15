"""forecast.py — forward-looking cycle roadmap.

Derives a probabilistic forecast from the already-computed top-3 analogs
and the actual current-cycle top observed in price history. No new
external data sources — everything comes from the same CryptoCompare
daily candles plus the analog results.

Outputs:
  - cycleTop: actual max since last halving (confirmed historical datum)
  - estimatedBottom: weighted-mean of analog-cycle drawdowns applied to
    the current cycle top, with a min/max confidence range
  - nextCycleTop: historical-gain × decay factor (0.45) applied forward
  - inflectionPoints: 2 heuristic mid-cycle extrema (relief rally +
    continuation pullback) + the bottom marker + the next-top marker
"""

from datetime import datetime, timedelta
from typing import List, Optional

import numpy as np

from cycle import HALVINGS

# User-specified baseline — opinionated decay curve across cycles
HISTORICAL_GAINS_PCT = [12000.0, 3000.0, 2000.0]
CYCLE_DECAY_FACTOR = 0.45
AVG_DAYS_BOTTOM_TO_NEXT_TOP = 456  # midpoint of historical 365-548 range


def _snap_to_seasonal_bottom(mechanical_date: datetime) -> datetime:
    """Snap the mechanical bottom estimate to November (mid-month).

    Bitcoin has bottomed in Oct-Nov in 3 of 4 completed cycles. Apply
    that seasonal pattern:
      - Aug through Jan : snap to the November inside that Aug-Jan
        window (same calendar year for Aug-Dec, previous calendar
        year for Jan — the November that just preceded it).
      - Feb through Jul : snap to next year's November per spec.
    """
    m = mechanical_date.month
    y = mechanical_date.year
    if 2 <= m <= 7:
        target_year = y + 1
    elif m == 1:
        # Jan is inside the Aug (Y-1) → Jan Y bottom-season window,
        # so the November for Jan Y is Nov Y-1.
        target_year = y - 1
    else:  # Aug..Dec
        target_year = y
    return datetime(target_year, 11, 15)


def _cycle_index_for_date(dt: datetime) -> int:
    """Halving-cycle index the given date falls into (0-based)."""
    for i in range(len(HALVINGS) - 1):
        if HALVINGS[i] <= dt < HALVINGS[i + 1]:
            return i
    return len(HALVINGS) - 2


def _find_cycle_top_bottom(
    dates: List[datetime],
    prices: np.ndarray,
    cycle_idx: int,
) -> Optional[dict]:
    """For halving cycle `cycle_idx`, return the cycle top + subsequent bottom.

    Top = max price between HALVINGS[idx] and HALVINGS[idx+1].
    Bottom = min price between top_date and HALVINGS[idx+2] (i.e. the
    bear market that runs into the next halving). Returns None if data
    doesn't cover the range.
    """
    start = HALVINGS[cycle_idx]
    end = HALVINGS[cycle_idx + 1] if cycle_idx + 1 < len(HALVINGS) else dates[-1]

    top_idx = None
    top_price = -1.0
    for i, d in enumerate(dates):
        if start <= d <= end and float(prices[i]) > top_price:
            top_price = float(prices[i])
            top_idx = i
    if top_idx is None:
        return None

    top_date = dates[top_idx]
    next_end = HALVINGS[cycle_idx + 2] if cycle_idx + 2 < len(HALVINGS) else dates[-1]
    bot_idx = None
    bot_price = float("inf")
    for i, d in enumerate(dates):
        if top_date < d <= next_end and float(prices[i]) < bot_price:
            bot_price = float(prices[i])
            bot_idx = i
    if bot_idx is None:
        return None

    return {
        "top_idx": top_idx, "top_date": top_date, "top_price": top_price,
        "bot_idx": bot_idx, "bot_date": dates[bot_idx], "bot_price": bot_price,
    }


def build_forecast(
    dates: List[datetime],
    prices: np.ndarray,
    analogs: List[dict],
) -> dict:
    today = dates[-1]
    current_cycle_idx = _cycle_index_for_date(today)
    current_cycle_start = HALVINGS[current_cycle_idx]

    # ── 1. Actual current cycle top (observed, not estimated) ──
    top_idx = None
    top_price = -1.0
    for i, d in enumerate(dates):
        if d >= current_cycle_start and float(prices[i]) > top_price:
            top_price = float(prices[i])
            top_idx = i
    if top_idx is None or top_price <= 0:
        current_top_date = today
        current_top_price = float(prices[-1])
    else:
        current_top_date = dates[top_idx]
        current_top_price = top_price

    # ── 2. Analog bear-market stats: days top→bottom, % drawdown ──
    analog_stats = []
    for a in analogs:
        end_str = a.get("endDate") or a.get("startDate", "")
        if not end_str:
            continue
        try:
            end_date = datetime.fromisoformat(end_str)
        except ValueError:
            continue
        cycle_idx = _cycle_index_for_date(end_date)
        bounds = _find_cycle_top_bottom(dates, prices, cycle_idx)
        if bounds is None or bounds["top_price"] <= 0:
            continue
        days_top_to_bot = (bounds["bot_date"] - bounds["top_date"]).days
        pct_drop = (bounds["bot_price"] - bounds["top_price"]) / bounds["top_price"] * 100
        analog_stats.append({
            "similarity": float(a.get("similarityScore", 50.0)),
            "date_label": str(a.get("date", "")),
            "days_top_to_bot": days_top_to_bot,
            "pct_drop": pct_drop,
        })

    # Weighted averages (by similarity score)
    if analog_stats:
        total_w = sum(s["similarity"] for s in analog_stats)
        if total_w <= 0:
            total_w = len(analog_stats)
            for s in analog_stats:
                s["similarity"] = 1.0
        avg_pct_drop = sum(s["pct_drop"] * s["similarity"] for s in analog_stats) / total_w
        avg_days = sum(s["days_top_to_bot"] * s["similarity"] for s in analog_stats) / total_w
        drops = [s["pct_drop"] for s in analog_stats]
        low_drop, high_drop = min(drops), max(drops)
    else:
        # Fallback when we have no analog history (shouldn't happen post-boot)
        avg_pct_drop = -75.0
        avg_days = 400.0
        low_drop, high_drop = -85.0, -55.0

    # ── 3. Estimated bottom ──
    # Mechanical date first (purely from analog day counts), then snap
    # the month to the nearest Oct-Nov bottom-season window.
    days_elapsed_from_top = (today - current_top_date).days
    days_remaining_mechanical = max(0, int(avg_days - days_elapsed_from_top))
    mechanical_bottom_date = today + timedelta(days=days_remaining_mechanical)
    est_bottom_date = _snap_to_seasonal_bottom(mechanical_bottom_date)
    # Recompute days_remaining from the seasonally adjusted date so the
    # downstream inflection spacing, chart timeline, and UI countdown all
    # agree on the same target.
    days_remaining = max(0, (est_bottom_date - today).days)
    est_bottom_price = current_top_price * (1 + avg_pct_drop / 100)
    # Price estimate is unchanged — only the date is seasonally adjusted.
    low_bottom = current_top_price * (1 + min(low_drop, high_drop) / 100)
    high_bottom = current_top_price * (1 + max(low_drop, high_drop) / 100)

    # ── 4. Next cycle top (applies decay to last historical gain) ──
    next_gain_pct = HISTORICAL_GAINS_PCT[-1] * CYCLE_DECAY_FACTOR
    est_next_top_price = est_bottom_price * (1 + next_gain_pct / 100)
    est_next_top_date = est_bottom_date + timedelta(days=AVG_DAYS_BOTTOM_TO_NEXT_TOP)
    # Confidence: 0.6x – 1.5x of midpoint gain
    next_top_low = est_bottom_price * (1 + next_gain_pct * 0.6 / 100)
    next_top_high = est_bottom_price * (1 + next_gain_pct * 1.5 / 100)

    # ── 5. Mid-cycle inflection points ──
    inflection_points = _build_inflections(
        today, current_top_price,
        est_bottom_date, est_bottom_price,
        est_next_top_date, est_next_top_price,
    )

    return {
        "cycleTop": {
            "price": round(current_top_price),
            "date": current_top_date.strftime("%Y-%m-%d"),
            "confirmed": True,
        },
        "estimatedBottom": {
            "price": round(est_bottom_price),
            "date": est_bottom_date.strftime("%Y-%m-%d"),
            "dropFromTop": round(avg_pct_drop, 1),
            "confidenceRange": {
                "low": round(min(low_bottom, high_bottom)),
                "high": round(max(low_bottom, high_bottom)),
            },
            "daysRemaining": days_remaining,
            "basedOnAnalogs": [s["date_label"] for s in analog_stats],
            "seasonallyAdjusted": True,
            "seasonalNote": (
                "Date adjusted to reflect Oct-Nov historical bottom "
                "seasonality (3 of 4 cycles bottomed Oct-Nov)."
            ),
        },
        "nextCycleTop": {
            "price": round(est_next_top_price),
            "date": est_next_top_date.strftime("%Y-%m-%d"),
            "gainFromBottom": round(next_gain_pct, 1),
            "confidenceRange": {
                "low": round(next_top_low),
                "high": round(next_top_high),
            },
        },
        "inflectionPoints": inflection_points,
        "disclaimer": (
            "Estimates based on 3 historical analogs. Bitcoin has "
            "completed only 3 full cycles. Treat as probabilistic "
            "ranges, not guarantees."
        ),
    }


def _build_inflections(
    today: datetime,
    current_top_price: float,
    est_bottom_date: datetime,
    est_bottom_price: float,
    est_next_top_date: datetime,
    est_next_top_price: float,
) -> List[dict]:
    """Produce 2-4 key inflection points between today and next cycle top.

    Uses heuristics scaled against the estimated bottom: a relief rally
    at 30% of days-to-bottom (bouncing back toward the prior mean) and a
    continuation pullback at 70% of days-to-bottom. These are shaped to
    mirror how past cycles' bear markets actually played out without
    over-claiming precision from noisy analog path averaging.
    """
    points: List[dict] = []
    days_to_bottom = max(0, (est_bottom_date - today).days)

    # Render rally/pullback whenever bottom is in the future, regardless
    # of how many days remain (the 60-day gate was removed).
    if days_to_bottom > 0:
        rally_offset = max(1, int(round(days_to_bottom * 0.30)))
        rally_date = today + timedelta(days=rally_offset)
        # Relief rally bounces to roughly 35% of the way back to cycle top
        # from the linear-interp price at that date
        frac_at_rally = rally_offset / days_to_bottom
        linear_at_rally = current_top_price + (est_bottom_price - current_top_price) * frac_at_rally
        rally_price = linear_at_rally + (current_top_price - linear_at_rally) * 0.35
        rally_magnitude = (rally_price - linear_at_rally) / linear_at_rally * 100
        points.append({
            "date": rally_date.strftime("%Y-%m-%d"),
            "price": round(rally_price),
            "type": "RALLY",
            "magnitude": round(rally_magnitude, 1),
            "description": "Bear market relief rally",
        })

        # Pullback must land after the rally and before the bottom
        pull_offset = min(days_to_bottom - 1, max(rally_offset + 1, int(round(days_to_bottom * 0.70))))
        pull_date = today + timedelta(days=pull_offset)
        frac_at_pull = pull_offset / days_to_bottom
        linear_at_pull = current_top_price + (est_bottom_price - current_top_price) * frac_at_pull
        pull_price = linear_at_pull
        pull_magnitude = (pull_price - rally_price) / rally_price * 100
        points.append({
            "date": pull_date.strftime("%Y-%m-%d"),
            "price": round(pull_price),
            "type": "PULLBACK",
            "magnitude": round(pull_magnitude, 1),
            "description": "Continuation of downtrend",
        })

    # Bottom marker (always)
    points.append({
        "date": est_bottom_date.strftime("%Y-%m-%d"),
        "price": round(est_bottom_price),
        "type": "BOTTOM",
        "magnitude": round((est_bottom_price - current_top_price) / current_top_price * 100, 1),
        "description": "Estimated cycle low",
    })

    # Next cycle top marker (always)
    points.append({
        "date": est_next_top_date.strftime("%Y-%m-%d"),
        "price": round(est_next_top_price),
        "type": "TOP",
        "magnitude": round((est_next_top_price - est_bottom_price) / est_bottom_price * 100, 1),
        "description": "Next cycle peak",
    })

    return points
