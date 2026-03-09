"""Signal explainer — generates natural language explanations for AI trading signals.

Converts raw model output (top features, regime, model contributions, attention)
into structured explanations that build user trust:
- Summary sentence: "Strong BUY — RSI oversold with bullish MACD cross in an uptrend"
- Reasons with weight indicators and category icons
- Caution warnings for conflicting signals
- Model vote visualization
- Attention highlight from TFT
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Feature → readable text mapping
# ---------------------------------------------------------------------------

# Categories map to frontend icon colors
FEATURE_CATEGORIES: dict[str, str] = {
    # Momentum
    "rsi_14": "momentum",
    "rsi_7": "momentum",
    "stoch_k": "momentum",
    "stoch_d": "momentum",
    "cci_14": "momentum",
    "willr_14": "momentum",
    "roc_10": "momentum",
    "roc_20": "momentum",
    "macd_hist": "momentum",
    "macd_line": "momentum",
    "macd_signal": "momentum",
    "mfi_14": "momentum",

    # Trend
    "adx_14": "trend",
    "plus_di_14": "trend",
    "minus_di_14": "trend",
    "ema_8": "trend",
    "ema_21": "trend",
    "ema_50": "trend",
    "ema_200": "trend",
    "ema_cross_8_21": "trend",
    "ema_cross_21_50": "trend",
    "dist_ema_8": "trend",
    "dist_ema_21": "trend",
    "dist_ema_50": "trend",
    "dist_ema_200": "trend",
    "ema_alignment": "trend",
    "supertrend_dir": "trend",
    "supertrend_dist": "trend",

    # Volatility
    "atr_14": "volatility",
    "atr_pct": "volatility",
    "bb_upper": "volatility",
    "bb_lower": "volatility",
    "bb_mid": "volatility",
    "bb_width": "volatility",
    "bb_pct_b": "volatility",
    "squeeze_on": "volatility",
    "kc_upper": "volatility",
    "kc_lower": "volatility",

    # Volume
    "volume_sma_20": "volume",
    "volume_ratio": "volume",
    "obv": "volume",
    "obv_slope": "volume",
    "vwap": "volume",
    "dist_vwap": "volume",

    # Price action / patterns
    "body_pct": "pattern",
    "upper_shadow_pct": "pattern",
    "lower_shadow_pct": "pattern",
    "is_doji": "pattern",
    "is_hammer": "pattern",
    "is_engulfing_bull": "pattern",
    "is_engulfing_bear": "pattern",
    "consecutive_up": "pattern",
    "consecutive_down": "pattern",
    "range_position": "pattern",
    "range_20_pct": "pattern",

    # Calendar
    "hour_of_day": "calendar",
    "day_of_week": "calendar",
    "is_weekend": "calendar",
}


def _describe_feature(name: str, value: float) -> str:
    """Convert a feature name + value into a readable sentence."""
    v = value

    # Momentum
    if name == "rsi_14":
        if v < 30:
            return f"RSI at {v:.1f} (oversold below 30)"
        elif v > 70:
            return f"RSI at {v:.1f} (overbought above 70)"
        return f"RSI at {v:.1f} (neutral zone)"
    if name == "rsi_7":
        if v < 25:
            return f"Fast RSI(7) at {v:.1f} — extremely oversold"
        elif v > 75:
            return f"Fast RSI(7) at {v:.1f} — extremely overbought"
        return f"Fast RSI(7) at {v:.1f}"
    if name == "macd_hist":
        return f"MACD histogram {'positive' if v > 0 else 'negative'} ({v:.4f})"
    if name == "macd_line":
        return f"MACD line at {v:.4f}"
    if name == "stoch_k":
        if v < 20:
            return f"Stochastic %K at {v:.0f} (oversold)"
        elif v > 80:
            return f"Stochastic %K at {v:.0f} (overbought)"
        return f"Stochastic %K at {v:.0f}"
    if name == "stoch_d":
        return f"Stochastic %D at {v:.0f}"
    if name == "cci_14":
        if v < -100:
            return f"CCI at {v:.0f} (oversold)"
        elif v > 100:
            return f"CCI at {v:.0f} (overbought)"
        return f"CCI at {v:.0f} (neutral)"
    if name == "willr_14":
        if v < -80:
            return f"Williams %R at {v:.0f} (oversold)"
        elif v > -20:
            return f"Williams %R at {v:.0f} (overbought)"
        return f"Williams %R at {v:.0f}"
    if name == "roc_10":
        return f"Rate of change(10) at {v:.2f}%"
    if name == "roc_20":
        return f"Rate of change(20) at {v:.2f}%"
    if name == "mfi_14":
        if v < 20:
            return f"Money Flow Index at {v:.0f} (oversold)"
        elif v > 80:
            return f"Money Flow Index at {v:.0f} (overbought)"
        return f"Money Flow Index at {v:.0f}"

    # Trend
    if name == "adx_14":
        return f"Trend strength ADX={v:.0f} ({'strong' if v > 25 else 'weak'})"
    if name == "plus_di_14":
        return f"+DI at {v:.1f}"
    if name == "minus_di_14":
        return f"-DI at {v:.1f}"
    if name == "ema_cross_8_21":
        return f"EMA 8/21 {'bullish' if v > 0 else 'bearish'} cross"
    if name == "ema_cross_21_50":
        return f"EMA 21/50 {'bullish' if v > 0 else 'bearish'} cross"
    if name.startswith("dist_ema_"):
        period = name.replace("dist_ema_", "")
        return f"Price {abs(v):.2%} {'above' if v > 0 else 'below'} EMA {period}"
    if name == "ema_alignment":
        if v == 1:
            return "EMAs in bullish alignment (8 > 21 > 50)"
        elif v == -1:
            return "EMAs in bearish alignment (50 > 21 > 8)"
        return "EMAs unaligned (mixed trend)"
    if name == "supertrend_dir":
        return f"Supertrend {'bullish' if v > 0 else 'bearish'}"
    if name == "supertrend_dist":
        return f"Distance to Supertrend: {abs(v):.2%}"

    # Volatility
    if name == "atr_14":
        return f"ATR(14) = {v:.2f}"
    if name == "atr_pct":
        return f"ATR {v:.2%} of price"
    if name == "bb_width":
        return f"Bollinger Band width: {v:.4f}"
    if name == "bb_pct_b":
        return f"Price at {v:.0%} of Bollinger Band range"
    if name == "squeeze_on":
        return f"Bollinger squeeze {'active' if v else 'released'}"

    # Volume
    if name == "volume_ratio":
        return f"Volume {v:.1f}x average"
    if name == "obv_slope":
        return f"OBV slope {'rising' if v > 0 else 'falling'} ({v:.0f})"
    if name == "dist_vwap":
        return f"Price {abs(v):.2%} {'above' if v > 0 else 'below'} VWAP"

    # Price action
    if name == "is_hammer":
        return "Hammer candle detected" if v else "No hammer pattern"
    if name == "is_doji":
        return "Doji candle (indecision)" if v else "Not a doji"
    if name == "is_engulfing_bull":
        return "Bullish engulfing pattern" if v else "No bullish engulfing"
    if name == "is_engulfing_bear":
        return "Bearish engulfing pattern" if v else "No bearish engulfing"
    if name == "consecutive_up":
        return f"{int(v)} consecutive bullish candles"
    if name == "consecutive_down":
        return f"{int(v)} consecutive bearish candles"
    if name == "range_position":
        return f"Price at {v:.0%} of 20-period range"

    # Higher-timeframe
    if name.startswith("htf_"):
        parts = name.split("_", 2)
        tf = parts[1] if len(parts) > 2 else "?"
        feat = parts[2] if len(parts) > 2 else name
        if feat == "rsi":
            return f"{tf} RSI at {v:.0f}"
        if feat == "adx":
            return f"{tf} trend strength ADX={v:.0f}"
        if feat == "trend":
            return f"{tf} trend {'bullish' if v > 0 else 'bearish'}"
        if feat == "supertrend":
            return f"{tf} Supertrend {'bullish' if v > 0 else 'bearish'}"
        if feat == "macd_hist":
            return f"{tf} MACD {'positive' if v > 0 else 'negative'}"
        if feat == "bb_width":
            return f"{tf} BB width {v:.4f}"
        return f"{tf} {feat}: {v:.4f}"

    # Fallback
    return f"{name}: {v:.4f}"


def _importance_weight(importance: float, rank: int) -> str:
    """Map feature importance + rank to a weight label."""
    if rank <= 1 or importance > 0.15:
        return "high"
    if rank <= 3 or importance > 0.08:
        return "medium"
    return "low"


def _build_summary(direction: str, confidence: float, reasons: list[dict]) -> str:
    """Build a one-sentence summary from the top reasons."""
    strength = "Strong" if confidence >= 85 else "Moderate" if confidence >= 75 else "Mild"

    if not reasons:
        return f"{strength} {direction} signal ({confidence:.0f}% confidence)"

    # Pick top 2-3 reasons for summary
    highlights = []
    for r in reasons[:3]:
        text = r["text"]
        # Shorten for summary
        if "oversold" in text.lower():
            highlights.append("RSI oversold")
        elif "overbought" in text.lower():
            highlights.append("RSI overbought")
        elif "bullish cross" in text.lower() or "bullish" in text.lower() and "cross" in text.lower():
            highlights.append("bullish cross")
        elif "bearish cross" in text.lower() or "bearish" in text.lower() and "cross" in text.lower():
            highlights.append("bearish cross")
        elif "macd" in text.lower() and "positive" in text.lower():
            highlights.append("MACD positive")
        elif "macd" in text.lower() and "negative" in text.lower():
            highlights.append("MACD negative")
        elif "adx" in text.lower() and "strong" in text.lower():
            highlights.append("strong trend")
        elif "volume" in text.lower() and "average" in text.lower():
            highlights.append("high volume")
        elif "squeeze" in text.lower():
            highlights.append("BB squeeze")
        elif "bullish alignment" in text.lower():
            highlights.append("uptrend")
        elif "bearish alignment" in text.lower():
            highlights.append("downtrend")
        elif "hammer" in text.lower():
            highlights.append("hammer candle")
        elif "engulfing" in text.lower():
            highlights.append("engulfing pattern")
        else:
            # Use first few words
            short = text.split("(")[0].strip()
            if len(short) > 30:
                short = short[:27] + "..."
            highlights.append(short)

    joined = " with ".join(highlights[:2])
    if len(highlights) > 2:
        joined += f" + {highlights[2]}"

    return f"{strength} {direction} — {joined}"


def _detect_caution(
    direction: str,
    top_features: list[dict],
    regime: dict | None,
) -> str | None:
    """Detect conflicting or cautionary signals."""
    cautions = []

    for f in top_features:
        name = f.get("feature", "")
        value = f.get("value")
        if value is None:
            continue
        v = float(value)

        # BUY signal but overbought indicators
        if direction == "BUY":
            if name == "rsi_14" and v > 70:
                cautions.append("RSI overbought despite BUY signal")
            if name == "stoch_k" and v > 80:
                cautions.append("Stochastic overbought")
            if name == "bb_pct_b" and v > 0.95:
                cautions.append("Price at upper Bollinger Band")

        # SELL signal but oversold indicators
        if direction == "SELL":
            if name == "rsi_14" and v < 30:
                cautions.append("RSI oversold despite SELL signal")
            if name == "stoch_k" and v < 20:
                cautions.append("Stochastic oversold")
            if name == "bb_pct_b" and v < 0.05:
                cautions.append("Price at lower Bollinger Band")

        # Volatility warnings
        if name == "bb_width" and v > 0.1:
            cautions.append("High volatility (wide Bollinger Bands)")
        if name == "squeeze_on" and v:
            cautions.append("Bollinger squeeze active — breakout pending")

    # Regime warnings
    if regime:
        regime_name = regime.get("regime", "")
        if regime_name == "volatile":
            cautions.append("Market regime: volatile — wider stops recommended")
        if regime_name == "quiet" and direction in ("BUY", "SELL"):
            cautions.append("Market regime: quiet — low momentum environment")

    if not cautions:
        return None
    return cautions[0]  # Return the most relevant caution


def generate_explanation(
    prediction: dict,
    top_features: list[dict],
    regime: dict | None = None,
    contributions: dict | None = None,
    attention: dict | None = None,
) -> dict:
    """
    Generate a structured explanation for an AI trading signal.

    Args:
        prediction: {direction, confidence, probabilities}
        top_features: [{feature, importance, value}, ...]
        regime: {regime, evidence, config} or None
        contributions: {model_name: {direction, confidence, weight}} or None
        attention: {temporal_attention, feature_importance} or None

    Returns:
        {
            summary: str,
            reasons: [{icon, text, weight}, ...],
            caution: str | None,
            model_votes: {model: direction} or None,
            attention_highlight: str | None,
        }
    """
    direction = prediction.get("direction", "NEUTRAL")
    confidence = prediction.get("confidence", 0)

    # Build reasons from top features
    reasons = []
    for i, f in enumerate(top_features[:6]):
        fname = f.get("feature", "unknown")
        importance = f.get("importance", 0)
        value = f.get("value")

        if value is None:
            continue

        text = _describe_feature(fname, float(value))
        category = FEATURE_CATEGORIES.get(fname, "other")
        weight = _importance_weight(importance, i)

        reasons.append({
            "icon": category,
            "text": text,
            "weight": weight,
        })

    # Add regime as a reason if available
    if regime:
        regime_name = regime.get("regime", "")
        evidence = regime.get("evidence", {})
        adx = evidence.get("adx", 0)

        regime_labels = {
            "trending_up": f"Market trending up (ADX={adx:.0f})" if adx else "Market trending up",
            "trending_down": f"Market trending down (ADX={adx:.0f})" if adx else "Market trending down",
            "ranging": "Market ranging (sideways)",
            "volatile": "High volatility regime",
            "quiet": "Low volatility / quiet market",
        }
        regime_text = regime_labels.get(regime_name, f"Market regime: {regime_name}")
        reasons.append({
            "icon": "regime",
            "text": regime_text,
            "weight": "medium",
        })

    # Add model agreement as a reason if available
    model_votes = None
    if contributions:
        model_votes = {}
        agree_count = 0
        total_models = 0
        for model_name, info in contributions.items():
            vote = info.get("direction", "NEUTRAL")
            model_votes[model_name] = vote
            total_models += 1
            if vote == direction:
                agree_count += 1

        if total_models > 1:
            reasons.append({
                "icon": "agreement",
                "text": f"{agree_count} of {total_models} models agree on {direction}",
                "weight": "high" if agree_count >= total_models * 0.75 else "medium",
            })

    # Summary
    summary = _build_summary(direction, confidence, reasons)

    # Caution
    caution = _detect_caution(direction, top_features, regime)

    # Attention highlight
    attention_highlight = None
    if attention and attention.get("temporal_attention"):
        try:
            temporal = attention["temporal_attention"]
            if isinstance(temporal, list) and len(temporal) > 2:
                # Find peak attention candle
                peak_idx = max(range(len(temporal)), key=lambda i: temporal[i])
                candles_ago = len(temporal) - 1 - peak_idx
                if candles_ago > 0:
                    attention_highlight = f"TFT focused on candle {candles_ago} periods ago"
        except (TypeError, IndexError):
            pass

    return {
        "summary": summary,
        "reasons": reasons[:6],  # Cap at 6 reasons
        "caution": caution,
        "model_votes": model_votes,
        "attention_highlight": attention_highlight,
    }
