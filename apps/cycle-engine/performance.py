"""performance.py — cycle-over-cycle cumulative return comparison.

For each completed + current halving cycle, computes monthly cumulative %
returns from the halving date price. Returns month-by-month data suitable
for a multi-line chart overlay plus an "insight" snapshot comparing the
current cycle's progress to prior cycles at the same elapsed month.
"""

from datetime import datetime, timedelta
from typing import List, Optional

import numpy as np

from cycle import HALVINGS

# Only cycles with sufficient daily data (CryptoCompare covers from ~2012).
# Cycle 1 (2012 halving) had very thin data; start from Cycle 2.
CYCLE_DEFS = [
    {"idx": 1, "name": "Cycle 2 (2016)", "halving": HALVINGS[1], "color": "#6B7280"},
    {"idx": 2, "name": "Cycle 3 (2020)", "halving": HALVINGS[2], "color": "#D97706"},
    {"idx": 3, "name": "Cycle 4 (Current)", "halving": HALVINGS[3], "color": "#F59E0B"},
]


def _closest_price(
    dates: List[datetime],
    prices: np.ndarray,
    target: datetime,
    max_delta_days: int = 5,
) -> Optional[float]:
    """Return the price on the date closest to `target`, within ±max_delta_days."""
    best_idx = None
    best_dist = max_delta_days + 1
    for i, d in enumerate(dates):
        dist = abs((d - target).days)
        if dist < best_dist:
            best_dist = dist
            best_idx = i
    if best_idx is None:
        return None
    return float(prices[best_idx])


def build_performance(
    dates: List[datetime],
    prices: np.ndarray,
) -> dict:
    today = dates[-1]
    cycles = []

    for cdef in CYCLE_DEFS:
        halving = cdef["halving"]
        is_current = cdef["idx"] == len(HALVINGS) - 2  # last known real halving
        next_halving = HALVINGS[cdef["idx"] + 1] if cdef["idx"] + 1 < len(HALVINGS) else None
        end_date = today if is_current else (next_halving or today)

        base_price = _closest_price(dates, prices, halving)
        if base_price is None or base_price <= 0:
            continue

        data_points = []
        peak_month: Optional[int] = None
        peak_return: Optional[float] = None
        month = 0

        while True:
            target = halving + timedelta(days=month * 30)
            if target > end_date:
                break
            p = _closest_price(dates, prices, target)
            if p is None:
                month += 1
                continue
            pct = ((p / base_price) - 1) * 100
            data_points.append({
                "month": month,
                "pctReturn": round(pct, 1),
                "price": round(p),
                "date": target.strftime("%Y-%m-%d"),
            })
            if peak_return is None or pct > peak_return:
                peak_return = pct
                peak_month = month
            month += 1

        total_months = None if is_current else (month - 1 if month > 0 else 0)

        cycles.append({
            "name": cdef["name"],
            "halvingDate": halving.strftime("%Y-%m-%d"),
            "color": cdef["color"],
            "data": data_points,
            "peakMonth": peak_month if not is_current else None,
            "peakReturn": round(peak_return, 1) if peak_return is not None and not is_current else None,
            "totalMonths": total_months,
        })

    # Insight: compare current vs prior cycles at the same elapsed month.
    current_cycle = next((c for c in cycles if "(Current)" in c["name"]), None)
    current_month = 0
    current_return = 0.0
    if current_cycle and current_cycle["data"]:
        last_pt = current_cycle["data"][-1]
        current_month = last_pt["month"]
        current_return = last_pt["pctReturn"]

    def _return_at_month(cycle: dict, m: int) -> Optional[float]:
        for pt in cycle["data"]:
            if pt["month"] == m:
                return pt["pctReturn"]
        return None

    c2 = next((c for c in cycles if "2016" in c["name"]), None)
    c3 = next((c for c in cycles if "2020" in c["name"]), None)
    c2_at = _return_at_month(c2, current_month) if c2 else None
    c3_at = _return_at_month(c3, current_month) if c3 else None

    avg_prior = []
    if c2_at is not None:
        avg_prior.append(c2_at)
    if c3_at is not None:
        avg_prior.append(c3_at)
    prior_avg = sum(avg_prior) / len(avg_prior) if avg_prior else 0.0

    if current_return > prior_avg * 1.15:
        status = "OUTPERFORMING"
    elif current_return < prior_avg * 0.85:
        status = "UNDERPERFORMING"
    else:
        status = "IN LINE"

    insight = {
        "cycle2AtSameMonth": round(c2_at, 1) if c2_at is not None else None,
        "cycle3AtSameMonth": round(c3_at, 1) if c3_at is not None else None,
        "currentReturn": round(current_return, 1),
        "performanceVsCycle2": round(current_return - c2_at, 1) if c2_at is not None else None,
        "performanceVsCycle3": round(current_return - c3_at, 1) if c3_at is not None else None,
        "status": status,
    }

    return {
        "cycles": cycles,
        "currentCycleMonth": current_month,
        "insight": insight,
    }
