"""onchain.py — on-chain-style metrics derived from price + market cap.

These are *proxies* computed from CoinGecko OHLCV + market cap data. They
approximate established on-chain metrics without requiring blockchain access:

  MVRV          — market cap / 155-day MA of market cap (realized proxy)
  NUPL          — (MVRV - 1) / MVRV (derives directly from MVRV)
  Puell         — today's price / 365-day avg price (block-reward cancels
                  when constant, so this matches real Puell far from halvings)
  Reserve Risk  — current price / cumulative(price × volume) HODL-bank proxy

Each metric returns: current value + percentile rank vs full history +
signal band + downsampled history for the frontend chart.
"""

from typing import List, Tuple

import numpy as np


def _percentile_rank(series: np.ndarray, value: float) -> float:
    if series.size == 0:
        return 0.0
    return float((series <= value).sum() / series.size * 100)


def moving_average(arr: np.ndarray, window: int) -> np.ndarray:
    """Simple MA; returns array of length len(arr) - window + 1."""
    if arr.size < window:
        return np.array([])
    kernel = np.ones(window) / window
    return np.convolve(arr, kernel, mode="valid")


def compute_mvrv(market_caps: np.ndarray) -> Tuple[float, float, np.ndarray]:
    """(current, percentile, series) — MVRV with 155d-MA as realized proxy."""
    if market_caps.size < 155:
        return 0.0, 0.0, np.array([])
    realized_proxy = moving_average(market_caps, 155)
    # Align the caps with the MA start (MA output is len - window + 1)
    mc_aligned = market_caps[154:]
    series = mc_aligned / np.maximum(realized_proxy, 1.0)
    current = float(series[-1])
    return current, _percentile_rank(series, current), series


def compute_puell(prices: np.ndarray) -> Tuple[float, float, np.ndarray]:
    """(current, percentile, series) — current price / 365d avg price.

    Block reward cancels out between numerator and denominator when they're
    the same issuance era. Drifts at halving boundaries — acceptable for
    a snapshot view.
    """
    if prices.size < 365:
        return 0.0, 0.0, np.array([])
    avg365 = moving_average(prices, 365)
    aligned = prices[364:]
    series = aligned / np.maximum(avg365, 1e-9)
    current = float(series[-1])
    return current, _percentile_rank(series, current), series


def compute_nupl(mvrv_current: float, mvrv_series: np.ndarray) -> Tuple[float, float, np.ndarray]:
    """NUPL = (MVRV - 1) / MVRV — direct derivation, not independent data."""
    if mvrv_series.size == 0 or mvrv_current <= 0:
        return 0.0, 0.0, np.array([])
    series = (mvrv_series - 1) / np.maximum(mvrv_series, 1e-9)
    current = (mvrv_current - 1) / mvrv_current
    return float(current), _percentile_rank(series, current), series


def compute_reserve_risk(
    prices: np.ndarray,
    volumes: np.ndarray,
) -> Tuple[float, float, np.ndarray]:
    """Proxy: current_price / cumulative(price × volume).

    Real Reserve Risk uses coin-days-destroyed which requires on-chain
    access. This cumulative-value-moved proxy has the right directional
    behavior (falls when price is low vs realized conviction, rises in
    euphoria) but the absolute thresholds below are calibrated loosely.
    """
    if prices.size < 365 or prices.size != volumes.size:
        return 0.0, 0.0, np.array([])
    pv = prices * volumes
    cumulative = np.cumsum(pv)
    series = prices / np.maximum(cumulative, 1.0)
    current = float(series[-1])
    return current, _percentile_rank(series, current), series


# ── Signal bands ──

def mvrv_signal(value: float) -> str:
    if value < 1:
        return "BUY ZONE"
    if value < 2:
        return "NEUTRAL"
    if value < 3.7:
        return "CAUTION"
    return "SELL ZONE"


def nupl_signal(value: float) -> str:
    if value < 0:
        return "CAPITULATION"
    if value < 0.25:
        return "HOPE/FEAR"
    if value < 0.5:
        return "OPTIMISM"
    if value < 0.75:
        return "BELIEF/DENIAL"
    return "EUPHORIA"


def puell_signal(value: float) -> str:
    if value < 0.5:
        return "BUY ZONE"
    if value < 1.5:
        return "NEUTRAL"
    if value < 3:
        return "CAUTION"
    return "SELL ZONE"


def reserve_risk_signal(value: float) -> str:
    if value < 0.002:
        return "BUY ZONE"
    if value < 0.02:
        return "NEUTRAL"
    return "SELL ZONE"


def _downsample(arr: np.ndarray, max_points: int = 365) -> List[float]:
    """Downsample to at most `max_points` evenly-spaced values."""
    if arr.size == 0:
        return []
    if arr.size <= max_points:
        return arr.round(6).tolist()
    step = arr.size / max_points
    indices = (np.arange(max_points) * step).astype(int)
    return arr[indices].round(6).tolist()


def build_onchain_section(
    prices: np.ndarray,
    market_caps: np.ndarray,
    volumes: np.ndarray,
    current_price: float,
) -> dict:
    mvrv_v, mvrv_p, mvrv_s = compute_mvrv(market_caps)
    puell_v, puell_p, puell_s = compute_puell(prices)
    nupl_v, nupl_p, nupl_s = compute_nupl(mvrv_v, mvrv_s)
    rr_v, rr_p, rr_s = compute_reserve_risk(prices, volumes)

    return {
        "mvrv": {
            "value": round(mvrv_v, 2),
            "percentile": round(mvrv_p, 1),
            "signal": mvrv_signal(mvrv_v),
            "history": _downsample(mvrv_s),
            "thresholds": {"buyZone": 1, "neutral": 2, "caution": 3.7},
            "description": "Market cap / 155-day MA. Realized-value proxy.",
        },
        "nupl": {
            "value": round(nupl_v, 3),
            "percentile": round(nupl_p, 1),
            "signal": nupl_signal(nupl_v),
            "history": _downsample(nupl_s),
            "thresholds": {"capitulation": 0, "hopefear": 0.25, "optimism": 0.5, "belief": 0.75},
            "description": "Net unrealized profit/loss across all holders.",
        },
        "puellMultiple": {
            "value": round(puell_v, 2),
            "percentile": round(puell_p, 1),
            "signal": puell_signal(puell_v),
            "history": _downsample(puell_s),
            "thresholds": {"buyZone": 0.5, "neutral": 1.5, "caution": 3},
            "description": "Miner-revenue intensity vs 365-day average.",
        },
        "reserveRisk": {
            "value": round(rr_v, 6),
            "percentile": round(rr_p, 1),
            "signal": reserve_risk_signal(rr_v),
            "history": _downsample(rr_s),
            "thresholds": {"buyZone": 0.002, "neutral": 0.02},
            "description": "Confidence proxy — low = asymmetric buy opportunity.",
        },
    }
