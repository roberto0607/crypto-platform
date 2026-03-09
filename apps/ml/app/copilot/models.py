"""Data models for the AI Trade Copilot."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MarketContext:
    """Aggregated market data sent from the frontend."""

    # Identity
    pair_id: str = ""
    pair_symbol: str = ""
    timeframe: str = "1h"
    current_price: float = 0.0
    timestamp: int = 0

    # ML Signal
    signal_active: bool = False
    signal_direction: str | None = None  # "BUY" | "SELL"
    signal_confidence: float = 0.0
    signal_entry_price: float | None = None
    signal_tp1: float | None = None
    signal_tp2: float | None = None
    signal_tp3: float | None = None
    signal_stop_loss: float | None = None
    signal_tp1_prob: float = 0.0
    signal_tp2_prob: float = 0.0
    signal_tp3_prob: float = 0.0
    signal_model_votes: dict[str, str] | None = None
    signal_regime: str | None = None
    signal_regime_confidence: float | None = None
    signal_strategy: str | None = None

    # TFT Forecast
    forecast_available: bool = False
    forecast_t1: dict[str, float] | None = None  # {p10, p50, p90}
    forecast_t3: dict[str, float] | None = None
    forecast_t6: dict[str, float] | None = None
    forecast_t12: dict[str, float] | None = None

    # Order Flow
    order_flow_available: bool = False
    order_flow_bid_ask_imbalance: float = 0.0
    order_flow_depth_ratio: float = 1.0
    order_flow_spread_bps: float = 0.0
    order_flow_whale_on_bid: bool = False
    order_flow_whale_on_ask: bool = False
    order_flow_bid_wall_price: float | None = None
    order_flow_ask_wall_price: float | None = None
    order_flow_bid_wall_distance: float = 0.0
    order_flow_ask_wall_distance: float = 0.0

    # Derivatives
    derivatives_available: bool = False
    derivatives_funding_rate: float = 0.0
    derivatives_oi_change_pct: float = 0.0
    derivatives_global_long_pct: float = 0.5
    derivatives_global_short_pct: float = 0.5
    derivatives_top_long_pct: float = 0.5
    derivatives_top_short_pct: float = 0.5
    derivatives_liq_pressure: float = 0.0
    derivatives_liq_intensity: float = 0.0

    # Price Action
    price_action_above_ema50: bool = False
    price_action_above_ema200: bool = False
    price_action_ema_alignment: str = "mixed"
    price_action_dist_from_vwap: float = 0.0
    price_action_rsi14: float = 50.0
    price_action_atr14: float = 0.0
    price_action_atr_pct: float = 0.0
    price_action_recent_swing_high: float | None = None
    price_action_recent_swing_low: float | None = None
    price_action_consecutive_green: int = 0
    price_action_consecutive_red: int = 0
    price_action_volume_trend: str = "flat"

    # Patterns
    patterns_available: bool = False
    pattern_type: str | None = None
    pattern_completion_pct: float = 0.0
    pattern_completion_prob: float = 0.0
    pattern_implied_direction: str | None = None
    pattern_target_price: float | None = None

    # Liquidity Zones
    liquidity_available: bool = False
    nearest_support_price: float | None = None
    nearest_support_strength: float = 0.0
    nearest_resistance_price: float | None = None
    nearest_resistance_strength: float = 0.0

    # Scenarios
    scenarios_available: bool = False
    scenario_bull_prob: float = 0.0
    scenario_bull_final: float = 0.0
    scenario_base_prob: float = 0.0
    scenario_base_final: float = 0.0
    scenario_bear_prob: float = 0.0
    scenario_bear_final: float = 0.0

    # User Position
    position_has_position: bool = False
    position_direction: str | None = None  # "LONG" | "SHORT"
    position_qty: float = 0.0
    position_entry_price: float | None = None
    position_unrealized_pnl: float = 0.0
    position_unrealized_pnl_pct: float = 0.0

    # Portfolio
    portfolio_equity: float = 0.0
    portfolio_cash_available: float = 0.0
    portfolio_cash_pct: float = 100.0

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MarketContext":
        """Build from frontend JSON (camelCase keys)."""
        ctx = cls()
        ctx.pair_id = d.get("pairId", "")
        ctx.pair_symbol = d.get("pairSymbol", "")
        ctx.timeframe = d.get("timeframe", "1h")
        ctx.current_price = d.get("currentPrice", 0)
        ctx.timestamp = d.get("timestamp", 0)

        sig = d.get("signal", {})
        ctx.signal_active = sig.get("active", False)
        ctx.signal_direction = sig.get("direction")
        ctx.signal_confidence = sig.get("confidence", 0)
        ctx.signal_entry_price = sig.get("entryPrice")
        ctx.signal_tp1 = sig.get("tp1")
        ctx.signal_tp2 = sig.get("tp2")
        ctx.signal_tp3 = sig.get("tp3")
        ctx.signal_stop_loss = sig.get("stopLoss")
        ctx.signal_tp1_prob = sig.get("tp1Prob", 0)
        ctx.signal_tp2_prob = sig.get("tp2Prob", 0)
        ctx.signal_tp3_prob = sig.get("tp3Prob", 0)
        ctx.signal_model_votes = sig.get("modelVotes")
        ctx.signal_regime = sig.get("regime")
        ctx.signal_regime_confidence = sig.get("regimeConfidence")
        ctx.signal_strategy = sig.get("strategy")

        fc = d.get("forecast", {})
        ctx.forecast_available = fc.get("available", False)
        ctx.forecast_t1 = fc.get("t1")
        ctx.forecast_t3 = fc.get("t3")
        ctx.forecast_t6 = fc.get("t6")
        ctx.forecast_t12 = fc.get("t12")

        of = d.get("orderFlow", {})
        ctx.order_flow_available = of.get("available", False)
        ctx.order_flow_bid_ask_imbalance = of.get("bidAskImbalance", 0)
        ctx.order_flow_depth_ratio = of.get("depthRatio", 1)
        ctx.order_flow_spread_bps = of.get("spreadBps", 0)
        ctx.order_flow_whale_on_bid = of.get("whaleOnBid", False)
        ctx.order_flow_whale_on_ask = of.get("whaleOnAsk", False)
        ctx.order_flow_bid_wall_price = of.get("bidWallPrice")
        ctx.order_flow_ask_wall_price = of.get("askWallPrice")
        ctx.order_flow_bid_wall_distance = of.get("bidWallDistance", 0)
        ctx.order_flow_ask_wall_distance = of.get("askWallDistance", 0)

        dv = d.get("derivatives", {})
        ctx.derivatives_available = dv.get("available", False)
        ctx.derivatives_funding_rate = dv.get("fundingRate", 0)
        ctx.derivatives_oi_change_pct = dv.get("oiChangePct", 0)
        ctx.derivatives_global_long_pct = dv.get("globalLongPct", 0.5)
        ctx.derivatives_global_short_pct = dv.get("globalShortPct", 0.5)
        ctx.derivatives_top_long_pct = dv.get("topLongPct", 0.5)
        ctx.derivatives_top_short_pct = dv.get("topShortPct", 0.5)
        ctx.derivatives_liq_pressure = dv.get("liqPressure", 0)
        ctx.derivatives_liq_intensity = dv.get("liqIntensity", 0)

        pa = d.get("priceAction", {})
        ctx.price_action_above_ema50 = pa.get("aboveEma50", False)
        ctx.price_action_above_ema200 = pa.get("aboveEma200", False)
        ctx.price_action_ema_alignment = pa.get("emaAlignment", "mixed")
        ctx.price_action_dist_from_vwap = pa.get("distFromVwap", 0)
        ctx.price_action_rsi14 = pa.get("rsi14", 50)
        ctx.price_action_atr14 = pa.get("atr14", 0)
        ctx.price_action_atr_pct = pa.get("atrPct", 0)
        ctx.price_action_recent_swing_high = pa.get("recentSwingHigh")
        ctx.price_action_recent_swing_low = pa.get("recentSwingLow")
        ctx.price_action_consecutive_green = pa.get("consecutiveGreen", 0)
        ctx.price_action_consecutive_red = pa.get("consecutiveRed", 0)
        ctx.price_action_volume_trend = pa.get("volumeTrend", "flat")

        pt = d.get("patterns", {})
        ctx.patterns_available = pt.get("available", False)
        top = pt.get("topPattern")
        if top:
            ctx.pattern_type = top.get("type")
            ctx.pattern_completion_pct = top.get("completionPct", 0)
            ctx.pattern_completion_prob = top.get("completionProb", 0)
            ctx.pattern_implied_direction = top.get("impliedDirection")
            ctx.pattern_target_price = top.get("targetPrice")

        lz = d.get("liquidityZones", {})
        ctx.liquidity_available = lz.get("available", False)
        ns = lz.get("nearestSupport")
        if ns:
            ctx.nearest_support_price = ns.get("price")
            ctx.nearest_support_strength = ns.get("strength", 0)
        nr = lz.get("nearestResistance")
        if nr:
            ctx.nearest_resistance_price = nr.get("price")
            ctx.nearest_resistance_strength = nr.get("strength", 0)

        sc = d.get("scenarios", {})
        ctx.scenarios_available = sc.get("available", False)
        bull = sc.get("bull") or {}
        ctx.scenario_bull_prob = bull.get("probability", 0)
        ctx.scenario_bull_final = bull.get("finalPrice", 0)
        base = sc.get("base") or {}
        ctx.scenario_base_prob = base.get("probability", 0)
        ctx.scenario_base_final = base.get("finalPrice", 0)
        bear = sc.get("bear") or {}
        ctx.scenario_bear_prob = bear.get("probability", 0)
        ctx.scenario_bear_final = bear.get("finalPrice", 0)

        pos = d.get("position", {})
        ctx.position_has_position = pos.get("hasPosition", False)
        ctx.position_direction = pos.get("direction")
        ctx.position_qty = pos.get("qty", 0)
        ctx.position_entry_price = pos.get("entryPrice")
        ctx.position_unrealized_pnl = pos.get("unrealizedPnl", 0)
        ctx.position_unrealized_pnl_pct = pos.get("unrealizedPnlPct", 0)

        pf = d.get("portfolio", {})
        ctx.portfolio_equity = pf.get("equity", 0)
        ctx.portfolio_cash_available = pf.get("cashAvailable", 0)
        ctx.portfolio_cash_pct = pf.get("cashPct", 100)

        return ctx


@dataclass
class DimensionScore:
    """Score from a single analysis dimension."""
    name: str
    score: float  # -100 to +100
    weight: float  # 0 to 1
    observations: list[str] = field(default_factory=list)


@dataclass
class Conviction:
    """Composite conviction from all dimensions."""
    score: int  # 0-100 (absolute strength)
    label: str  # "strong_buy" | "lean_long" | "neutral" | "lean_short" | "strong_sell"
    direction: str  # "BUY" | "SELL" | "NEUTRAL"
    levels: dict[str, Any] | None = None


@dataclass
class CopilotAnalysis:
    """Final analysis output sent to the frontend."""
    conviction: int
    conviction_label: str
    market_read: str
    trade_idea: str
    trade_levels: dict[str, Any] | None
    risk_flags: list[dict[str, str]]
    position_advice: str
    key_datapoints: list[dict[str, Any]]
    changes_since_last: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "conviction": self.conviction,
            "convictionLabel": self.conviction_label,
            "marketRead": self.market_read,
            "tradeIdea": self.trade_idea,
            "tradeLevels": self.trade_levels,
            "riskFlags": self.risk_flags,
            "positionAdvice": self.position_advice,
            "keyDatapoints": self.key_datapoints,
            "changesSinceLast": self.changes_since_last,
        }
