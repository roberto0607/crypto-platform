"""analog.py — historical analog matching via DTW + multi-dimensional similarity.

Sliding 90-day windows across all history since 2012-11-28; each candidate
is scored against the current 90-day window on four axes:

  price pattern (30%)   — DTW distance of re-centered log-returns
  cycle position (25%)  — abs diff in days-since-halving (cap at 365)
  on-chain (25%)        — weighted MVRV/NUPL/Puell deltas
  volatility (20%)      — abs diff in return stddev (cap at 0.05)

Top-3 scored candidates are returned with at least 365-day separation
between them (prevents near-duplicates from overlapping windows).
"""

from datetime import datetime
from typing import List, Tuple

import numpy as np
from dtaidistance import dtw

from cycle import HALVINGS

WINDOW_SIZE = 90
FORWARD_WINDOW = 180
TOP_N = 3
MIN_SEPARATION_DAYS = 365


def _normalize_returns(prices: np.ndarray) -> np.ndarray:
    """Zero-centered log-returns — pattern, not level."""
    if prices.size < 2:
        return np.zeros(prices.size, dtype=np.double)
    log_prices = np.log(np.maximum(prices, 1e-9))
    returns = np.diff(log_prices, prepend=log_prices[0])
    return (returns - returns.mean()).astype(np.double)


def _calc_similarity(
    current_returns: np.ndarray,
    candidate_returns: np.ndarray,
    current_cycle_day: int,
    candidate_cycle_day: int,
    current_onchain: dict,
    candidate_onchain: dict,
) -> dict:
    # 1. Price pattern (30%)
    try:
        dtw_dist = float(dtw.distance(current_returns, candidate_returns))
    except Exception:
        dtw_dist = 1.0
    price_score = 1.0 / (1.0 + dtw_dist)

    # 2. Cycle position (25%)
    cycle_day_diff = abs(candidate_cycle_day - current_cycle_day)
    cycle_score = max(0.0, 1.0 - (cycle_day_diff / 365.0))

    # 3. On-chain (25%)
    mvrv_diff = abs(candidate_onchain.get("mvrv", 0.0) - current_onchain.get("mvrv", 0.0))
    nupl_diff = abs(candidate_onchain.get("nupl", 0.0) - current_onchain.get("nupl", 0.0))
    puell_diff = abs(candidate_onchain.get("puell", 0.0) - current_onchain.get("puell", 0.0))
    onchain_score = (
        max(0.0, 1.0 - mvrv_diff / 2.0) * 0.4
        + max(0.0, 1.0 - nupl_diff / 0.3) * 0.3
        + max(0.0, 1.0 - puell_diff / 1.0) * 0.3
    )

    # 4. Volatility regime (20%)
    current_vol = float(np.std(current_returns))
    candidate_vol = float(np.std(candidate_returns))
    vol_diff = abs(current_vol - candidate_vol)
    vol_score = max(0.0, 1.0 - vol_diff / 0.05)

    final = (
        price_score * 0.30
        + cycle_score * 0.25
        + onchain_score * 0.25
        + vol_score * 0.20
    )
    return {
        "score": round(final * 100, 1),
        "price": round(price_score * 100, 1),
        "cycle": round(cycle_score * 100, 1),
        "onchain": round(onchain_score * 100, 1),
        "volatility": round(vol_score * 100, 1),
    }


def _format_analog_date(dt: datetime) -> str:
    months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    return f"{months[dt.month - 1]} {dt.year}"


def _days_since_halving_for(dt: datetime) -> int:
    last = max((h for h in HALVINGS if h <= dt), default=HALVINGS[0])
    return (dt - last).days


def find_top_analogs(
    dates: List[datetime],
    prices: np.ndarray,
    daily_onchain: List[dict],
    cycle_days: np.ndarray,
) -> Tuple[List[dict], dict]:
    """Return (top-3 analog dicts, consensus outcome dict)."""
    n = len(dates)
    if n < WINDOW_SIZE + FORWARD_WINDOW + 1 or prices.size != n:
        return [], _empty_consensus()

    current_start = n - WINDOW_SIZE
    current_window = prices[current_start:]
    current_returns = _normalize_returns(current_window)
    current_cycle_day = int(cycle_days[-1])
    current_onchain = daily_onchain[-1]

    # Don't let candidate windows overlap "now" or its forward slot
    last_valid_end = n - FORWARD_WINDOW - 1
    if last_valid_end < WINDOW_SIZE:
        return [], _empty_consensus()

    results = []
    for end_idx in range(WINDOW_SIZE, last_valid_end + 1):
        # Candidate window [start_idx, end_idx)
        start_idx = end_idx - WINDOW_SIZE
        # Skip if candidate overlaps the current window
        if end_idx > current_start - 30:
            break
        cand_prices = prices[start_idx:end_idx]
        cand_returns = _normalize_returns(cand_prices)
        cand_cycle_day = int(cycle_days[end_idx - 1])
        cand_onchain = daily_onchain[end_idx - 1]

        sim = _calc_similarity(
            current_returns, cand_returns,
            current_cycle_day, cand_cycle_day,
            current_onchain, cand_onchain,
        )
        results.append({
            "end_idx": end_idx,
            "start_idx": start_idx,
            "score": sim["score"],
            "breakdown": sim,
        })

    # Pick top N with minimum separation
    results.sort(key=lambda r: r["score"], reverse=True)
    picked: List[dict] = []
    for r in results:
        if len(picked) >= TOP_N:
            break
        if any(abs(r["end_idx"] - p["end_idx"]) < MIN_SEPARATION_DAYS for p in picked):
            continue
        picked.append(r)

    # Build analog payloads
    analogs = []
    for r in picked:
        start_idx, end_idx = r["start_idx"], r["end_idx"]
        start_date = dates[start_idx]
        price_at_time = float(prices[end_idx - 1])
        fwd_slice = prices[end_idx - 1:end_idx - 1 + FORWARD_WINDOW + 1]

        def change_at(days: int) -> dict:
            if fwd_slice.size <= days:
                return {"pct": 0.0, "price": 0.0}
            future = float(fwd_slice[days])
            pct = (future - price_at_time) / price_at_time * 100 if price_at_time > 0 else 0.0
            return {"pct": round(pct, 1), "price": round(future)}

        end_date = dates[end_idx - 1]
        analogs.append({
            "date": _format_analog_date(start_date),
            "startDate": start_date.strftime("%Y-%m-%d"),
            "endDate": end_date.strftime("%Y-%m-%d"),
            "similarityScore": r["score"],
            "priceAtTime": round(price_at_time),
            "cycleDay": _days_since_halving_for(dates[end_idx - 1]),
            "priceChange": {
                "30d": change_at(30),
                "90d": change_at(90),
                "180d": change_at(180),
            },
            "historicalPrices": [round(p, 2) for p in prices[start_idx:end_idx].tolist()],
            "forwardPrices": [round(p, 2) for p in fwd_slice.tolist()],
            "breakdown": r["breakdown"],
        })

    consensus = _consensus(analogs)
    return analogs, consensus


def _consensus(analogs: List[dict]) -> dict:
    def outcomes(horizon: int) -> dict:
        pcts = [a["priceChange"][f"{horizon}d"]["pct"] for a in analogs]
        if not pcts:
            return {"median": 0, "min": 0, "max": 0, "bullish": 0, "bearish": 0}
        return {
            "median": round(float(np.median(pcts)), 1),
            "min": round(min(pcts), 1),
            "max": round(max(pcts), 1),
            "bullish": sum(1 for p in pcts if p > 0),
            "bearish": sum(1 for p in pcts if p <= 0),
        }

    return {"30d": outcomes(30), "90d": outcomes(90), "180d": outcomes(180)}


def _empty_consensus() -> dict:
    zero = {"median": 0, "min": 0, "max": 0, "bullish": 0, "bearish": 0}
    return {"30d": zero, "90d": zero, "180d": zero}
