"""Market regime detection — classifies current market conditions.

Uses technical indicators to determine if the market is:
  - TRENDING_UP:   Strong uptrend (ADX>25, EMA aligned, close > EMA50)
  - TRENDING_DOWN: Strong downtrend (ADX>25, close < EMA50)
  - RANGING:       Sideways / choppy (ADX<20, tight BB)
  - VOLATILE:      High volatility breakout (expanding BB, high ATR)
  - QUIET:         Low volatility squeeze (BB inside KC, low ATR)

Regime detection feeds into the ensemble meta-learner to adjust
signal generation thresholds and TP/SL multipliers.
"""

from dataclasses import dataclass
from enum import Enum

import numpy as np
import pandas as pd


class MarketRegime(Enum):
    TRENDING_UP = "trending_up"
    TRENDING_DOWN = "trending_down"
    RANGING = "ranging"
    VOLATILE = "volatile"
    QUIET = "quiet"


@dataclass
class RegimeConfig:
    """Regime-specific signal generation parameters."""
    min_confidence: float
    tp_multiplier: float
    sl_multiplier: float
    description: str


# Regime-specific adjustments
REGIME_CONFIGS: dict[MarketRegime, RegimeConfig] = {
    MarketRegime.TRENDING_UP: RegimeConfig(
        min_confidence=65.0,
        tp_multiplier=1.5,
        sl_multiplier=1.0,
        description="Strong uptrend — lower confidence threshold, wider TPs",
    ),
    MarketRegime.TRENDING_DOWN: RegimeConfig(
        min_confidence=65.0,
        tp_multiplier=1.5,
        sl_multiplier=1.0,
        description="Strong downtrend — lower confidence threshold, wider TPs",
    ),
    MarketRegime.RANGING: RegimeConfig(
        min_confidence=80.0,
        tp_multiplier=0.7,
        sl_multiplier=0.8,
        description="Ranging market — higher confidence threshold, tighter TPs",
    ),
    MarketRegime.VOLATILE: RegimeConfig(
        min_confidence=85.0,
        tp_multiplier=2.0,
        sl_multiplier=1.5,
        description="Volatile market — highest threshold, wide stops",
    ),
    MarketRegime.QUIET: RegimeConfig(
        min_confidence=75.0,
        tp_multiplier=1.0,
        sl_multiplier=1.0,
        description="Quiet market — anticipate breakout, standard zones",
    ),
}


def detect_regime(df: pd.DataFrame) -> tuple[MarketRegime, dict]:
    """
    Detect the current market regime from a feature DataFrame.

    Args:
        df: Feature DataFrame with at least: adx_14, bb_width, ema_50,
            close, atr_14, volume, squeeze_on, plus_di, minus_di.

    Returns:
        (regime, evidence_dict) — the detected regime and supporting data.
    """
    latest = df.iloc[-1]
    lookback = df.tail(20)

    evidence: dict = {}

    # --- ADX: Trend strength ---
    adx = float(latest.get("adx_14", 20))
    evidence["adx"] = round(adx, 1)

    # --- EMA alignment ---
    close = float(latest["close"])
    ema_50 = float(latest.get("ema_50", close))
    ema_200 = float(latest.get("ema_200", close))
    above_ema50 = close > ema_50
    above_ema200 = close > ema_200
    emas_stacked_bull = ema_50 > ema_200
    evidence["above_ema50"] = above_ema50
    evidence["emas_stacked_bull"] = emas_stacked_bull

    # --- Plus/Minus DI ---
    plus_di = float(latest.get("plus_di", 20))
    minus_di = float(latest.get("minus_di", 20))
    evidence["plus_di"] = round(plus_di, 1)
    evidence["minus_di"] = round(minus_di, 1)

    # --- Bollinger Band width ---
    bb_width = float(latest.get("bb_width", 0.05))
    bb_width_avg = float(lookback["bb_width"].mean()) if "bb_width" in lookback.columns else bb_width
    bb_expanding = bb_width > bb_width_avg * 1.3
    bb_contracting = bb_width < bb_width_avg * 0.7
    evidence["bb_width"] = round(bb_width, 4)
    evidence["bb_expanding"] = bb_expanding
    evidence["bb_contracting"] = bb_contracting

    # --- Squeeze detection ---
    squeeze_on = bool(latest.get("squeeze_on", False))
    evidence["squeeze_on"] = squeeze_on

    # --- ATR trend ---
    atr = float(latest.get("atr_14", 0))
    atr_avg = float(lookback["atr_14"].mean()) if "atr_14" in lookback.columns else atr
    atr_rising = atr > atr_avg * 1.2
    evidence["atr_rising"] = atr_rising

    # --- Volume profile ---
    vol_ratio = float(latest.get("volume_ratio", 1.0))
    evidence["volume_ratio"] = round(vol_ratio, 2)

    # --- Classification logic ---

    # QUIET: Squeeze is on (BB inside KC) and low volatility
    if squeeze_on and not atr_rising and bb_contracting:
        return MarketRegime.QUIET, evidence

    # VOLATILE: Expanding BB + rising ATR
    if bb_expanding and atr_rising:
        return MarketRegime.VOLATILE, evidence

    # TRENDING_UP: ADX > 25 + bullish alignment
    if adx > 25 and above_ema50 and plus_di > minus_di:
        return MarketRegime.TRENDING_UP, evidence

    # TRENDING_DOWN: ADX > 25 + bearish alignment
    if adx > 25 and not above_ema50 and minus_di > plus_di:
        return MarketRegime.TRENDING_DOWN, evidence

    # RANGING: Low ADX
    if adx < 20:
        return MarketRegime.RANGING, evidence

    # Default: check trend direction even with moderate ADX
    if above_ema50 and emas_stacked_bull:
        return MarketRegime.TRENDING_UP, evidence
    elif not above_ema50 and not emas_stacked_bull:
        return MarketRegime.TRENDING_DOWN, evidence

    return MarketRegime.RANGING, evidence


def get_regime_config(regime: MarketRegime) -> RegimeConfig:
    """Get signal generation parameters for a given regime."""
    return REGIME_CONFIGS[regime]
