"""CopilotAnalyzer — weighted scoring + narrative assembly.

Every sentence is derived from live data. Nothing is hardcoded as text —
all prose is constructed from scored observations.
"""

from __future__ import annotations

from .models import (
    MarketContext,
    DimensionScore,
    Conviction,
    CopilotAnalysis,
)


class CopilotAnalyzer:
    """Generates dynamic plain-English trade analysis from market context."""

    _previous_conviction: str | None = None
    _previous_direction: str | None = None

    def analyze(self, ctx: MarketContext) -> CopilotAnalysis:
        scores = self._score_all_dimensions(ctx)
        conviction = self._compute_conviction(scores, ctx)
        market_read = self._build_market_read(ctx, scores)
        trade_idea = self._build_trade_idea(ctx, scores, conviction)
        risk_flags = self._build_risk_flags(ctx, scores)
        position_advice = self._build_position_advice(ctx, conviction)
        key_datapoints = self._extract_key_datapoints(ctx, scores)
        changes = self._detect_changes(conviction)

        return CopilotAnalysis(
            conviction=conviction.score,
            conviction_label=conviction.label,
            market_read=market_read,
            trade_idea=trade_idea,
            trade_levels=conviction.levels,
            risk_flags=risk_flags,
            position_advice=position_advice,
            key_datapoints=key_datapoints,
            changes_since_last=changes,
        )

    # ── Dimension Scoring ────────────────────────────────────

    def _score_all_dimensions(self, ctx: MarketContext) -> dict[str, DimensionScore]:
        return {
            "ml_signal": self._score_ml_signal(ctx),
            "forecast": self._score_forecast(ctx),
            "order_flow": self._score_order_flow(ctx),
            "derivatives": self._score_derivatives(ctx),
            "price_action": self._score_price_action(ctx),
            "pattern": self._score_pattern(ctx),
            "liquidity": self._score_liquidity(ctx),
            "scenarios": self._score_scenarios(ctx),
        }

    def _score_ml_signal(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.signal_active:
            observations.append("No active AI signal")
            return DimensionScore("ml_signal", 0, 0.25, observations)

        direction_mult = 1 if ctx.signal_direction == "BUY" else -1
        score = direction_mult * ctx.signal_confidence

        observations.append(
            f"The ensemble is {ctx.signal_confidence:.0f}% confident {ctx.signal_direction}"
        )

        if ctx.signal_model_votes:
            votes = list(ctx.signal_model_votes.values())
            agree_count = votes.count(ctx.signal_direction)
            total = len(votes)
            if agree_count == total:
                observations.append(f"All {total} models agree on {ctx.signal_direction}")
                score *= 1.15
            elif agree_count >= total * 0.75:
                observations.append(f"{agree_count} of {total} models agree")
            else:
                disagreeing = [
                    k for k, v in ctx.signal_model_votes.items()
                    if v != ctx.signal_direction
                ]
                observations.append(f"Split vote — {', '.join(disagreeing)} disagree")
                score *= 0.8

        if ctx.signal_regime:
            regime = ctx.signal_regime
            if "UP" in regime or "DOWN" in regime:
                regime_dir = "BUY" if "UP" in regime else "SELL"
                if regime_dir == ctx.signal_direction:
                    observations.append(
                        f"Signal aligns with {regime.replace('_', ' ').lower()} regime"
                    )
                else:
                    observations.append(
                        f"Signal conflicts with {regime.replace('_', ' ').lower()} regime"
                    )
                    score *= 0.7

        return DimensionScore("ml_signal", score, 0.25, observations)

    def _score_forecast(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.forecast_available:
            return DimensionScore("forecast", 0, 0.0, ["Forecast data unavailable"])

        # Use t6 (6-candle horizon) as primary
        fc = ctx.forecast_t6 or ctx.forecast_t3 or ctx.forecast_t1
        if not fc:
            return DimensionScore("forecast", 0, 0.0, ["No forecast horizons available"])

        p50 = fc.get("p50", 0)
        p10 = fc.get("p10", 0)
        p90 = fc.get("p90", 0)

        if ctx.current_price > 0:
            median_pct = ((p50 - ctx.current_price) / ctx.current_price) * 100
            spread_pct = ((p90 - p10) / ctx.current_price) * 100

            score = median_pct * 30  # Scale: 1% move → 30 points
            score = max(-80, min(80, score))

            direction = "up" if median_pct > 0 else "down"
            observations.append(
                f"TFT forecast median is {median_pct:+.1f}% ({direction} to ${p50:,.0f})"
            )

            if spread_pct > 3:
                observations.append(
                    f"Wide forecast cone ({spread_pct:.1f}% spread) — high uncertainty"
                )
                score *= 0.7
            elif spread_pct < 1:
                observations.append("Tight forecast cone — model is confident in direction")

        return DimensionScore("forecast", score, 0.10, observations)

    def _score_order_flow(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.order_flow_available:
            return DimensionScore("order_flow", 0, 0.0, ["Order flow data unavailable"])

        imb = ctx.order_flow_bid_ask_imbalance
        score = imb * 50  # [-1,1] → [-50,50]

        if abs(imb) > 0.3:
            side = "buy" if imb > 0 else "sell"
            observations.append(f"Order flow skewed toward {side} ({imb:+.2f} imbalance)")

        if ctx.order_flow_whale_on_bid and not ctx.order_flow_whale_on_ask:
            observations.append("Large buyer detected in the order book")
            score += 15
        elif ctx.order_flow_whale_on_ask and not ctx.order_flow_whale_on_bid:
            observations.append("Large seller detected in the order book")
            score -= 15

        dr = ctx.order_flow_depth_ratio
        if dr > 1.5:
            observations.append(f"Buy-side depth is {dr:.1f}x thicker than sell-side")
        elif dr < 0.67:
            observations.append(f"Sell-side depth is {1 / dr:.1f}x thicker than buy-side")

        if ctx.order_flow_bid_wall_price:
            observations.append(
                f"Bid wall at ${ctx.order_flow_bid_wall_price:,.0f} "
                f"({ctx.order_flow_bid_wall_distance:.1f}% below)"
            )
        if ctx.order_flow_ask_wall_price:
            observations.append(
                f"Ask wall at ${ctx.order_flow_ask_wall_price:,.0f} "
                f"({ctx.order_flow_ask_wall_distance:.1f}% above)"
            )

        return DimensionScore("order_flow", score, 0.15, observations)

    def _score_derivatives(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.derivatives_available:
            return DimensionScore("derivatives", 0, 0.0, ["Derivatives data unavailable"])

        fr = ctx.derivatives_funding_rate
        if abs(fr) < 0.005:
            observations.append(f"Funding rate is neutral ({fr:.4f}%) — no overcrowding")
        elif fr > 0.02:
            observations.append(
                f"Funding rate is elevated ({fr:.4f}%) — longs may be overleveraged"
            )
            score -= 20
        elif fr < -0.02:
            observations.append(
                f"Funding rate is negative ({fr:.4f}%) — shorts paying longs"
            )
            score += 20

        oi_change = ctx.derivatives_oi_change_pct
        if oi_change > 2:
            observations.append(
                f"Open interest rising {oi_change:.1f}% — fresh capital entering"
            )
        elif oi_change < -2:
            observations.append(
                f"Open interest falling {abs(oi_change):.1f}% — positions closing"
            )

        top_long = ctx.derivatives_top_long_pct
        if top_long > 0.6:
            observations.append(
                f"Top traders are {top_long * 100:.0f}% long — institutional bias bullish"
            )
            score += 15
        elif top_long < 0.4:
            observations.append(
                f"Top traders are {(1 - top_long) * 100:.0f}% short — contrarian pressure exists"
            )
            score -= 10

        if ctx.derivatives_liq_intensity > 0.3:
            direction = "shorts" if ctx.derivatives_liq_pressure > 0 else "longs"
            observations.append(
                f"Liquidation wave detected — {direction} being squeezed"
            )

        return DimensionScore("derivatives", score, 0.15, observations)

    def _score_price_action(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        # EMA alignment
        if ctx.price_action_ema_alignment == "bullish":
            observations.append("Price is above key moving averages with bullish alignment")
            score += 20
        elif ctx.price_action_ema_alignment == "bearish":
            observations.append("Price is below key moving averages under bearish pressure")
            score -= 20
        else:
            observations.append("Moving averages are mixed — no clear trend")

        # RSI
        rsi = ctx.price_action_rsi14
        if rsi > 70:
            observations.append(f"RSI is overbought at {rsi:.0f}")
            score -= 15
        elif rsi < 30:
            observations.append(f"RSI is oversold at {rsi:.0f}")
            score += 15
        elif 45 <= rsi <= 55:
            observations.append(f"RSI is neutral at {rsi:.0f}")

        # VWAP distance
        vwap_dist = ctx.price_action_dist_from_vwap
        if abs(vwap_dist) > 1.5:
            side = "above" if vwap_dist > 0 else "below"
            observations.append(f"Price is {abs(vwap_dist):.1f}% {side} VWAP")

        # Consecutive candles
        if ctx.price_action_consecutive_green >= 5:
            observations.append(
                f"{ctx.price_action_consecutive_green} consecutive green candles — momentum is strong"
            )
            score += 10
        elif ctx.price_action_consecutive_red >= 5:
            observations.append(
                f"{ctx.price_action_consecutive_red} consecutive red candles — selling pressure"
            )
            score -= 10

        # Volume trend
        if ctx.price_action_volume_trend == "increasing":
            observations.append("Volume is expanding — moves are conviction-backed")
        elif ctx.price_action_volume_trend == "decreasing":
            observations.append("Volume is declining — momentum may be fading")

        return DimensionScore("price_action", score, 0.15, observations)

    def _score_pattern(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.patterns_available or not ctx.pattern_type:
            return DimensionScore("pattern", 0, 0.0, ["No chart patterns detected"])

        direction_mult = 1 if ctx.pattern_implied_direction == "BUY" else -1
        score = direction_mult * ctx.pattern_completion_prob * 60

        target_str = ""
        if ctx.pattern_target_price and ctx.current_price > 0:
            target_pct = (
                (ctx.pattern_target_price - ctx.current_price) / ctx.current_price * 100
            )
            target_str = f" with a target at ${ctx.pattern_target_price:,.0f} ({target_pct:+.1f}%)"

        observations.append(
            f"A {ctx.pattern_type} is {ctx.pattern_completion_pct:.0f}% formed "
            f"({ctx.pattern_completion_prob * 100:.0f}% completion probability, "
            f"implies {ctx.pattern_implied_direction}){target_str}"
        )

        return DimensionScore("pattern", score, 0.10, observations)

    def _score_liquidity(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.liquidity_available:
            return DimensionScore("liquidity", 0, 0.0, ["Liquidity zone data unavailable"])

        if ctx.nearest_support_price and ctx.current_price > 0:
            dist = (ctx.current_price - ctx.nearest_support_price) / ctx.current_price * 100
            observations.append(
                f"Support at ${ctx.nearest_support_price:,.0f} "
                f"(strength {ctx.nearest_support_strength:.0f}, {dist:.1f}% below)"
            )
            if dist < 1.0 and ctx.nearest_support_strength > 50:
                score += 10  # Near strong support is bullish

        if ctx.nearest_resistance_price and ctx.current_price > 0:
            dist = (ctx.nearest_resistance_price - ctx.current_price) / ctx.current_price * 100
            observations.append(
                f"Resistance at ${ctx.nearest_resistance_price:,.0f} "
                f"(strength {ctx.nearest_resistance_strength:.0f}, {dist:.1f}% above)"
            )
            if dist < 1.0 and ctx.nearest_resistance_strength > 50:
                score -= 10  # Near strong resistance is bearish

        return DimensionScore("liquidity", score, 0.05, observations)

    def _score_scenarios(self, ctx: MarketContext) -> DimensionScore:
        observations: list[str] = []
        score = 0.0

        if not ctx.scenarios_available:
            return DimensionScore("scenarios", 0, 0.0, ["Scenario data unavailable"])

        bull_p = ctx.scenario_bull_prob
        bear_p = ctx.scenario_bear_prob

        if bull_p > bear_p + 0.15:
            score = (bull_p - bear_p) * 50
            observations.append(
                f"AI scenarios favor bull ({bull_p * 100:.0f}%) over bear ({bear_p * 100:.0f}%)"
            )
        elif bear_p > bull_p + 0.15:
            score = -(bear_p - bull_p) * 50
            observations.append(
                f"AI scenarios favor bear ({bear_p * 100:.0f}%) over bull ({bull_p * 100:.0f}%)"
            )
        else:
            observations.append("AI scenarios show balanced probabilities")

        if ctx.scenario_bull_final and ctx.current_price > 0:
            bull_ret = (ctx.scenario_bull_final - ctx.current_price) / ctx.current_price * 100
            bear_ret = (ctx.scenario_bear_final - ctx.current_price) / ctx.current_price * 100
            observations.append(
                f"Bull target ${ctx.scenario_bull_final:,.0f} ({bull_ret:+.1f}%), "
                f"bear target ${ctx.scenario_bear_final:,.0f} ({bear_ret:+.1f}%)"
            )

        return DimensionScore("scenarios", score, 0.05, observations)

    # ── Conviction ───────────────────────────────────────────

    def _compute_conviction(
        self, scores: dict[str, DimensionScore], ctx: MarketContext
    ) -> Conviction:
        weighted_sum = 0.0
        total_weight = 0.0
        for dim in scores.values():
            weighted_sum += dim.score * dim.weight
            total_weight += dim.weight

        raw_score = weighted_sum / total_weight if total_weight > 0 else 0.0

        abs_score = abs(raw_score)
        direction = "BUY" if raw_score > 5 else "SELL" if raw_score < -5 else "NEUTRAL"

        if abs_score >= 70:
            label = "strong_buy" if raw_score > 0 else "strong_sell"
        elif abs_score >= 40:
            label = "lean_long" if raw_score > 0 else "lean_short"
        else:
            label = "neutral"

        # Build trade levels from active signal if available
        levels = None
        if ctx.signal_active and ctx.signal_entry_price:
            rr = 0.0
            if ctx.signal_stop_loss and ctx.signal_tp2:
                risk = abs(ctx.signal_entry_price - ctx.signal_stop_loss)
                reward = abs(ctx.signal_tp2 - ctx.signal_entry_price)
                rr = round(reward / risk, 1) if risk > 0 else 0

            levels = {
                "entry": ctx.signal_entry_price,
                "tp1": ctx.signal_tp1,
                "tp2": ctx.signal_tp2,
                "tp3": ctx.signal_tp3,
                "sl": ctx.signal_stop_loss,
                "rrRatio": rr,
                "tp1Prob": ctx.signal_tp1_prob,
                "tp2Prob": ctx.signal_tp2_prob,
                "tp3Prob": ctx.signal_tp3_prob,
            }

        return Conviction(
            score=round(abs_score),
            label=label,
            direction=direction,
            levels=levels,
        )

    # ── Narrative Assembly ───────────────────────────────────

    def _build_market_read(
        self, ctx: MarketContext, scores: dict[str, DimensionScore]
    ) -> str:
        pair = ctx.pair_symbol.split("/")[0] if "/" in ctx.pair_symbol else ctx.pair_symbol

        # Build regime intro
        if ctx.signal_regime:
            regime_text = ctx.signal_regime.replace("_", " ").lower()
            intro = f"{pair} is in a {regime_text} regime"
            if ctx.signal_regime_confidence and ctx.signal_regime_confidence > 0.7:
                intro += " with high confidence"
            intro += "."
        elif ctx.price_action_ema_alignment == "bullish":
            intro = f"{pair} is trading above key moving averages with bullish alignment."
        elif ctx.price_action_ema_alignment == "bearish":
            intro = f"{pair} is trading below key moving averages under bearish pressure."
        else:
            intro = f"{pair} is consolidating with mixed signals across timeframes."

        # Collect all observations, sort by importance
        all_obs: list[tuple[float, str]] = []
        for dim in scores.values():
            for obs in dim.observations:
                all_obs.append((abs(dim.score) * dim.weight, obs))
        all_obs.sort(key=lambda x: x[0], reverse=True)

        top_obs = [obs for _, obs in all_obs[:3] if obs]
        sentences = [intro] + top_obs
        return " ".join(sentences)

    def _build_trade_idea(
        self,
        ctx: MarketContext,
        scores: dict[str, DimensionScore],
        conviction: Conviction,
    ) -> str:
        if conviction.label == "neutral":
            reasons = self._get_conflicting_signals(scores)
            return (
                f"No clear trade setup right now. "
                f"Signals are mixed — {reasons}. "
                f"Wait for alignment before entering."
            )

        direction_word = "long" if conviction.direction == "BUY" else "short"
        strength = "Strong" if conviction.score >= 70 else "Lean"

        parts = [f"{strength} {direction_word}."]

        ml = scores.get("ml_signal")
        if ml and ml.observations:
            parts.append(ml.observations[0] + ".")

        pattern = scores.get("pattern")
        if pattern and pattern.score != 0 and pattern.observations:
            parts.append(pattern.observations[0] + ".")

        forecast = scores.get("forecast")
        if forecast and forecast.score != 0 and forecast.observations:
            parts.append(forecast.observations[0] + ".")

        return " ".join(parts)

    def _build_position_advice(
        self, ctx: MarketContext, conviction: Conviction
    ) -> str:
        if ctx.position_has_position:
            dir_word = "long" if ctx.position_direction == "LONG" else "short"
            pnl = ctx.position_unrealized_pnl_pct

            if conviction.direction == "NEUTRAL":
                return (
                    f"You're currently {dir_word} with {pnl:+.1f}% unrealized. "
                    f"Conviction has dropped to neutral — consider tightening your stop "
                    f"or taking partial profit."
                )

            same_direction = (
                (ctx.position_direction == "LONG" and conviction.direction == "BUY")
                or (ctx.position_direction == "SHORT" and conviction.direction == "SELL")
            )

            if same_direction and pnl > 0:
                return (
                    f"You're {dir_word} with {pnl:+.1f}% unrealized and conviction "
                    f"remains {conviction.label.replace('_', ' ')}. Let it run — "
                    f"trail your stop to protect gains."
                )
            elif not same_direction:
                return (
                    f"You're {dir_word} but conviction has flipped to "
                    f"{conviction.label.replace('_', ' ')}. Consider exiting "
                    f"or reducing your position."
                )
            else:
                return (
                    f"You're {dir_word} at {pnl:+.1f}%. "
                    f"Hold for now — the setup hasn't invalidated."
                )

        # No position
        equity = ctx.portfolio_equity
        cash_pct = ctx.portfolio_cash_pct
        pair = ctx.pair_symbol.split("/")[0] if "/" in ctx.pair_symbol else ctx.pair_symbol

        if conviction.score < 40:
            return (
                f"You have no open position in {pair}. With conviction at only "
                f"{conviction.score}%, this isn't a high-probability entry. "
                f"Stay patient."
            )

        if conviction.score >= 70:
            alloc_pct = "8-12%"
            alloc_low = equity * 0.08
            alloc_high = equity * 0.12
        elif conviction.score >= 50:
            alloc_pct = "5-8%"
            alloc_low = equity * 0.05
            alloc_high = equity * 0.08
        else:
            alloc_pct = "3-5%"
            alloc_low = equity * 0.03
            alloc_high = equity * 0.05

        return (
            f"You have no open position in {pair}. "
            f"Your portfolio is {cash_pct:.0f}% cash "
            f"(${ctx.portfolio_cash_available:,.0f} available). "
            f"Based on {conviction.score}% conviction, a {alloc_pct} allocation "
            f"(${alloc_low:,.0f}–${alloc_high:,.0f}) would be appropriate."
        )

    def _build_risk_flags(
        self, ctx: MarketContext, scores: dict[str, DimensionScore]
    ) -> list[dict[str, str]]:
        flags: list[dict[str, str]] = []

        # Derivatives risks
        if ctx.derivatives_available:
            fr = ctx.derivatives_funding_rate
            if abs(fr) > 0.02:
                side = "long" if fr > 0 else "short"
                flags.append({
                    "severity": "warning",
                    "text": f"Elevated funding rate ({fr:.4f}%) — {side} overcrowding risk",
                    "icon": "warning",
                })
            else:
                flags.append({
                    "severity": "ok",
                    "text": "Funding rate neutral — no overcrowding",
                    "icon": "check",
                })

            top_short = ctx.derivatives_top_short_pct
            if top_short > 0.55:
                flags.append({
                    "severity": "warning",
                    "text": f"Top traders are {top_short * 100:.0f}% short — contrarian pressure",
                    "icon": "warning",
                })

            if ctx.derivatives_liq_intensity > 0.3:
                flags.append({
                    "severity": "danger",
                    "text": "Active liquidation cascade detected — volatility spike likely",
                    "icon": "danger",
                })
            else:
                flags.append({
                    "severity": "ok",
                    "text": "No liquidation cascade risk detected",
                    "icon": "check",
                })

        # Liquidity zone proximity
        if ctx.liquidity_available and ctx.nearest_resistance_price and ctx.current_price > 0:
            dist_pct = (
                (ctx.nearest_resistance_price - ctx.current_price)
                / ctx.current_price
                * 100
            )
            if dist_pct < 1.0 and ctx.nearest_resistance_strength > 50:
                flags.append({
                    "severity": "warning",
                    "text": (
                        f"Approaching resistance at ${ctx.nearest_resistance_price:,.0f} "
                        f"(strength {ctx.nearest_resistance_strength:.0f}, {dist_pct:.1f}% away)"
                    ),
                    "icon": "warning",
                })

        # RSI extremes
        rsi = ctx.price_action_rsi14
        if rsi > 75:
            flags.append({
                "severity": "warning",
                "text": f"RSI is overbought at {rsi:.0f} — pullback risk elevated",
                "icon": "warning",
            })
        elif rsi < 25:
            flags.append({
                "severity": "warning",
                "text": f"RSI is oversold at {rsi:.0f} — bounce likely",
                "icon": "warning",
            })

        # Model disagreement
        if ctx.signal_model_votes:
            directions = set(ctx.signal_model_votes.values())
            if len(directions) > 1:
                flags.append({
                    "severity": "warning",
                    "text": "AI models are split — low consensus increases uncertainty",
                    "icon": "warning",
                })
            else:
                flags.append({
                    "severity": "ok",
                    "text": "All AI models agree on direction",
                    "icon": "check",
                })

        return flags

    # ── Helpers ───────────────────────────────────────────────

    def _extract_key_datapoints(
        self, ctx: MarketContext, scores: dict[str, DimensionScore]
    ) -> list[dict]:
        points: list[dict] = []

        points.append({
            "label": "Price",
            "value": f"${ctx.current_price:,.2f}",
            "sentiment": "neutral",
        })

        if ctx.signal_active:
            sentiment = "bullish" if ctx.signal_direction == "BUY" else "bearish"
            points.append({
                "label": "AI Signal",
                "value": f"{ctx.signal_direction} {ctx.signal_confidence:.0f}%",
                "sentiment": sentiment,
            })

        if ctx.signal_regime:
            points.append({
                "label": "Regime",
                "value": ctx.signal_regime.replace("_", " ").title(),
                "sentiment": "neutral",
            })

        rsi = ctx.price_action_rsi14
        rsi_sent = "bearish" if rsi > 70 else "bullish" if rsi < 30 else "neutral"
        points.append({"label": "RSI", "value": f"{rsi:.0f}", "sentiment": rsi_sent})

        if ctx.derivatives_available:
            points.append({
                "label": "Funding",
                "value": f"{ctx.derivatives_funding_rate:.4f}%",
                "sentiment": "neutral",
            })

        if ctx.order_flow_available:
            imb = ctx.order_flow_bid_ask_imbalance
            imb_sent = "bullish" if imb > 0.2 else "bearish" if imb < -0.2 else "neutral"
            points.append({
                "label": "Flow",
                "value": f"{imb:+.2f}",
                "sentiment": imb_sent,
            })

        return points

    def _get_conflicting_signals(self, scores: dict[str, DimensionScore]) -> str:
        bullish = [s.name for s in scores.values() if s.score > 15]
        bearish = [s.name for s in scores.values() if s.score < -15]

        if bullish and bearish:
            b_names = ", ".join(s.replace("_", " ") for s in bullish)
            s_names = ", ".join(s.replace("_", " ") for s in bearish)
            return f"{b_names} lean bullish while {s_names} lean bearish"
        return "no strong conviction from any dimension"

    def _detect_changes(self, conviction: Conviction) -> list[str]:
        changes: list[str] = []
        if (
            self._previous_conviction
            and conviction.label != self._previous_conviction
        ):
            changes.append(
                f"Conviction shifted from {self._previous_conviction.replace('_', ' ')} "
                f"to {conviction.label.replace('_', ' ')}"
            )
        if (
            self._previous_direction
            and conviction.direction != self._previous_direction
        ):
            changes.append(
                f"Direction flipped from {self._previous_direction} to {conviction.direction}"
            )
        self._previous_conviction = conviction.label
        self._previous_direction = conviction.direction
        return changes
