"""Signal generator — converts model predictions into actionable trading signals.

Takes raw model output (direction + confidence) and produces:
- BUY / SELL signal (or None if below threshold)
- TP1 / TP2 / TP3 take-profit zones (ATR-based, volatility-adaptive)
- Stop-loss level
- Top contributing features
"""

from dataclasses import dataclass, asdict
from datetime import datetime, timezone


@dataclass
class Signal:
    signal_type: str  # "BUY" or "SELL"
    confidence: float  # 0-100
    entry_price: float
    tp1: float
    tp2: float
    tp3: float
    stop_loss: float
    tp1_prob: float  # Historical hit rate (set during backtest calibration)
    tp2_prob: float
    tp3_prob: float
    top_features: list[dict]
    model_version: str
    generated_at: str

    def to_dict(self) -> dict:
        return asdict(self)


# ATR multipliers for TP zones and stop-loss
TP1_MULT = 1.0  # Conservative
TP2_MULT = 2.0  # Moderate
TP3_MULT = 3.5  # Aggressive
SL_MULT = 1.2   # Stop-loss

# Default hit rate estimates (will be calibrated from backtest data)
DEFAULT_TP1_PROB = 78.0
DEFAULT_TP2_PROB = 55.0
DEFAULT_TP3_PROB = 35.0


def generate_signal(
    prediction: dict,
    current_price: float,
    atr: float,
    min_confidence: float = 70.0,
    top_features: list[dict] | None = None,
    model_version: str = "unknown",
    tp_probs: dict | None = None,
    learned_zones: dict | None = None,
) -> Signal | None:
    """
    Convert a model prediction into a trading signal.

    Args:
        prediction: Output from XGBoostModel.predict() with
                    direction, confidence, probabilities.
        current_price: Current asset price.
        atr: Current ATR_14 value (for TP/SL sizing).
        min_confidence: Minimum confidence to emit a signal.
        top_features: Feature importance list from model.
        model_version: Model version string.
        tp_probs: Custom TP hit probabilities from backtest.
        learned_zones: Data-driven TP/SL from TargetPredictor.
                       If provided, overrides ATR-based zones.

    Returns:
        Signal object or None if confidence is too low or direction is NEUTRAL.
    """
    direction = prediction["direction"]
    confidence = prediction["confidence"]

    # No signal if below threshold or neutral
    if confidence < min_confidence or direction == "NEUTRAL":
        return None

    probs = tp_probs or {
        "tp1": DEFAULT_TP1_PROB,
        "tp2": DEFAULT_TP2_PROB,
        "tp3": DEFAULT_TP3_PROB,
    }

    if learned_zones:
        # Use data-driven zones from TargetPredictor
        tp1 = learned_zones["tp1"]
        tp2 = learned_zones["tp2"]
        tp3 = learned_zones["tp3"]
        stop_loss = learned_zones["stop_loss"]
    elif direction == "BUY":
        tp1 = current_price + TP1_MULT * atr
        tp2 = current_price + TP2_MULT * atr
        tp3 = current_price + TP3_MULT * atr
        stop_loss = current_price - SL_MULT * atr
    else:  # SELL
        tp1 = current_price - TP1_MULT * atr
        tp2 = current_price - TP2_MULT * atr
        tp3 = current_price - TP3_MULT * atr
        stop_loss = current_price + SL_MULT * atr

    return Signal(
        signal_type=direction,
        confidence=round(confidence, 1),
        entry_price=round(current_price, 2),
        tp1=round(tp1, 2),
        tp2=round(tp2, 2),
        tp3=round(tp3, 2),
        stop_loss=round(stop_loss, 2),
        tp1_prob=probs["tp1"],
        tp2_prob=probs["tp2"],
        tp3_prob=probs["tp3"],
        top_features=top_features or [],
        model_version=model_version,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
