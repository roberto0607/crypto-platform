import { useState, useEffect, useCallback, useRef } from "react";
import { getSignals, getOrderFlow, getDerivatives, getScenarios } from "@/api/endpoints/signals";
import { getCandles, type Candle } from "@/api/endpoints/candles";
import { getSummary } from "@/api/endpoints/portfolio";
import { listOrders } from "@/api/endpoints/trading";

export interface MarketContext {
    pairId: string;
    pairSymbol: string;
    timeframe: string;
    currentPrice: number;
    timestamp: number;

    signal: {
        active: boolean;
        direction: "BUY" | "SELL" | null;
        confidence: number;
        entryPrice: number | null;
        tp1: number | null;
        tp2: number | null;
        tp3: number | null;
        stopLoss: number | null;
        tp1Prob: number;
        tp2Prob: number;
        tp3Prob: number;
        modelVotes: Record<string, string> | null;
        regime: string | null;
        regimeConfidence: number | null;
        strategy: string | null;
    };

    forecast: {
        available: boolean;
        t1: { p10: number; p50: number; p90: number } | null;
        t3: { p10: number; p50: number; p90: number } | null;
        t6: { p10: number; p50: number; p90: number } | null;
        t12: { p10: number; p50: number; p90: number } | null;
    };

    orderFlow: {
        available: boolean;
        bidAskImbalance: number;
        depthRatio: number;
        spreadBps: number;
        whaleOnBid: boolean;
        whaleOnAsk: boolean;
        bidWallPrice: number | null;
        askWallPrice: number | null;
        bidWallDistance: number;
        askWallDistance: number;
    };

    derivatives: {
        available: boolean;
        fundingRate: number;
        oiChangePct: number;
        globalLongPct: number;
        globalShortPct: number;
        topLongPct: number;
        topShortPct: number;
        liqPressure: number;
        liqIntensity: number;
    };

    priceAction: {
        aboveEma50: boolean;
        aboveEma200: boolean;
        emaAlignment: "bullish" | "bearish" | "mixed";
        distFromVwap: number;
        rsi14: number;
        atr14: number;
        atrPct: number;
        recentSwingHigh: number | null;
        recentSwingLow: number | null;
        consecutiveGreen: number;
        consecutiveRed: number;
        volumeTrend: "increasing" | "decreasing" | "flat";
    };

    patterns: {
        available: boolean;
        topPattern: {
            type: string;
            completionPct: number;
            completionProb: number;
            impliedDirection: string;
            targetPrice: number;
        } | null;
    };

    liquidityZones: {
        available: boolean;
        nearestSupport: { price: number; strength: number } | null;
        nearestResistance: { price: number; strength: number } | null;
    };

    scenarios: {
        available: boolean;
        bull: { probability: number; finalPrice: number } | null;
        base: { probability: number; finalPrice: number } | null;
        bear: { probability: number; finalPrice: number } | null;
    };

    position: {
        hasPosition: boolean;
        direction: "LONG" | "SHORT" | null;
        qty: number;
        entryPrice: number | null;
        unrealizedPnl: number;
        unrealizedPnlPct: number;
    };

    portfolio: {
        equity: number;
        cashAvailable: number;
        cashPct: number;
    };
}

// ── Price-action helpers ─────────────────────────────────

function computeEMA(candles: Candle[], period: number): number | null {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let ema = Number(candles[0]!.close);
    for (let i = 1; i < candles.length; i++) {
        ema = Number(candles[i]!.close) * k + ema * (1 - k);
    }
    return ema;
}

function computeRSI(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const diff = Number(candles[i]!.close) - Number(candles[i - 1]!.close);
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

function computeATR(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 0;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const h = Number(candles[i]!.high);
        const l = Number(candles[i]!.low);
        const pc = Number(candles[i - 1]!.close);
        sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    return sum / period;
}

function computeVWAP(candles: Candle[]): number | null {
    if (candles.length === 0) return null;
    let cumVP = 0;
    let cumVol = 0;
    for (const c of candles) {
        const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
        const vol = Number(c.volume);
        cumVP += tp * vol;
        cumVol += vol;
    }
    return cumVol > 0 ? cumVP / cumVol : null;
}

function countConsecutive(candles: Candle[]): { green: number; red: number } {
    let green = 0;
    let red = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i]!;
        const isGreen = Number(c.close) >= Number(c.open);
        if (isGreen) {
            if (red > 0) break;
            green++;
        } else {
            if (green > 0) break;
            red++;
        }
    }
    return { green, red };
}

function volumeTrend(candles: Candle[]): "increasing" | "decreasing" | "flat" {
    if (candles.length < 10) return "flat";
    const recent5 = candles.slice(-5).reduce((s, c) => s + Number(c.volume), 0) / 5;
    const prev5 = candles.slice(-10, -5).reduce((s, c) => s + Number(c.volume), 0) / 5;
    if (prev5 === 0) return "flat";
    const ratio = recent5 / prev5;
    if (ratio > 1.2) return "increasing";
    if (ratio < 0.8) return "decreasing";
    return "flat";
}

function findSwingHigh(candles: Candle[]): number | null {
    if (candles.length < 5) return null;
    let high = -Infinity;
    for (const c of candles.slice(-20)) {
        const h = Number(c.high);
        if (h > high) high = h;
    }
    return high;
}

function findSwingLow(candles: Candle[]): number | null {
    if (candles.length < 5) return null;
    let low = Infinity;
    for (const c of candles.slice(-20)) {
        const l = Number(c.low);
        if (l < low) low = l;
    }
    return low;
}

// ── Main hook ────────────────────────────────────────────

export function useCopilotContext(
    pairId: string | null,
    pairSymbol: string,
    timeframe: string,
    enabled: boolean,
): { context: MarketContext | null; loading: boolean; lastUpdated: number } {
    const [context, setContext] = useState<MarketContext | null>(null);
    const [lastUpdated, setLastUpdated] = useState(0);
    const mountedRef = useRef(true);

    const refresh = useCallback(async () => {
        if (!pairId || !enabled) return;

        const [signalRes, orderFlowRes, derivativesRes, portfolioRes, candleRes, scenarioRes, ordersRes] =
            await Promise.allSettled([
                getSignals(pairId, { timeframe, limit: 5 }),
                getOrderFlow(pairId),
                getDerivatives(pairId),
                getSummary(),
                getCandles(pairId, { timeframe: timeframe as "1h", limit: 50 }),
                getScenarios(pairId, { timeframe }),
                listOrders({ pairId, status: "OPEN", limit: 10 }),
            ]);

        if (!mountedRef.current) return;

        // Signal
        const sigData =
            signalRes.status === "fulfilled" ? signalRes.value.data : null;
        const active = sigData?.active ?? null;

        // Forecast from signal
        const fc = active?.forecast ?? null;

        // Order flow
        const ofData =
            orderFlowRes.status === "fulfilled"
                ? orderFlowRes.value.data.features
                : null;

        // Derivatives
        const dvData =
            derivativesRes.status === "fulfilled"
                ? derivativesRes.value.data.derivatives
                : null;

        // Portfolio
        const pfData =
            portfolioRes.status === "fulfilled"
                ? portfolioRes.value.data.summary
                : null;

        // Candles
        const candles: Candle[] =
            candleRes.status === "fulfilled"
                ? candleRes.value.data.candles
                : [];

        // Scenarios
        const scData =
            scenarioRes.status === "fulfilled"
                ? scenarioRes.value.data
                : null;

        // Open orders (position proxy)
        const openOrders =
            ordersRes.status === "fulfilled"
                ? ordersRes.value.data.orders
                : [];

        // Compute price action from candles
        const currentPrice =
            candles.length > 0 ? Number(candles[candles.length - 1]!.close) : 0;
        const ema50 = computeEMA(candles, 50);
        const ema200 = computeEMA(candles, 200);
        const aboveEma50 = ema50 != null && currentPrice > ema50;
        const aboveEma200 = ema200 != null && currentPrice > ema200;
        const emaAlignment: "bullish" | "bearish" | "mixed" =
            aboveEma50 && aboveEma200
                ? "bullish"
                : !aboveEma50 && !aboveEma200
                    ? "bearish"
                    : "mixed";

        const vwap = computeVWAP(candles);
        const distFromVwap =
            vwap && currentPrice > 0
                ? ((currentPrice - vwap) / vwap) * 100
                : 0;

        const rsi14 = computeRSI(candles);
        const atr14 = computeATR(candles);
        const atrPct = currentPrice > 0 ? (atr14 / currentPrice) * 100 : 0;
        const { green: consecutiveGreen, red: consecutiveRed } =
            countConsecutive(candles);

        // Position — approximate from open orders
        const buyOrders = openOrders.filter((o) => o.side === "BUY");
        const sellOrders = openOrders.filter((o) => o.side === "SELL");
        const hasPosition = buyOrders.length > 0 || sellOrders.length > 0;

        // Portfolio
        const equity = pfData ? Number(pfData.equity_quote) : 0;
        const cashAvailable = pfData ? Number(pfData.cash_quote) : 0;
        const cashPct = equity > 0 ? (cashAvailable / equity) * 100 : 100;

        // Build scenarios
        const scenarios = scData?.scenarios ?? [];
        const bullSc = scenarios.find((s) => s.name === "bull");
        const baseSc = scenarios.find((s) => s.name === "base");
        const bearSc = scenarios.find((s) => s.name === "bear");

        const ctx: MarketContext = {
            pairId,
            pairSymbol,
            timeframe,
            currentPrice,
            timestamp: Date.now(),

            signal: {
                active: active != null,
                direction: active?.signalType ?? null,
                confidence: active ? active.confidence : 0,
                entryPrice: active ? Number(active.entryPrice) : null,
                tp1: active ? Number(active.tp1Price) : null,
                tp2: active ? Number(active.tp2Price) : null,
                tp3: active ? Number(active.tp3Price) : null,
                stopLoss: active ? Number(active.stopLossPrice) : null,
                tp1Prob: active?.tp1Prob ?? 0,
                tp2Prob: active?.tp2Prob ?? 0,
                tp3Prob: active?.tp3Prob ?? 0,
                modelVotes: active?.explanation?.model_votes ?? null,
                regime: active?.regime ?? null,
                regimeConfidence: active?.regimeConfidence ?? null,
                strategy: active?.strategy ?? null,
            },

            forecast: {
                available: fc != null,
                t1: fc?.["1"] ?? null,
                t3: fc?.["3"] ?? null,
                t6: fc?.["6"] ?? null,
                t12: fc?.["12"] ?? null,
            },

            orderFlow: {
                available: ofData != null,
                bidAskImbalance: ofData?.bidAskImbalance ?? 0,
                depthRatio: ofData?.depthRatio ?? 1,
                spreadBps: ofData?.spreadBps ?? 0,
                whaleOnBid: ofData?.largeOrderBid ?? false,
                whaleOnAsk: ofData?.largeOrderAsk ?? false,
                bidWallPrice: ofData?.bidWallPrice ?? null,
                askWallPrice: ofData?.askWallPrice ?? null,
                bidWallDistance: ofData?.bidWallDistance ?? 0,
                askWallDistance: ofData?.askWallDistance ?? 0,
            },

            derivatives: {
                available: dvData != null,
                fundingRate: dvData?.fundingRate ?? 0,
                oiChangePct: dvData?.oiChangePct ?? 0,
                globalLongPct: dvData?.globalLongPct ?? 0.5,
                globalShortPct: dvData?.globalShortPct ?? 0.5,
                topLongPct: dvData?.topLongPct ?? 0.5,
                topShortPct: dvData?.topShortPct ?? 0.5,
                liqPressure: dvData?.liqPressure ?? 0,
                liqIntensity: dvData?.liqIntensity ?? 0,
            },

            priceAction: {
                aboveEma50,
                aboveEma200,
                emaAlignment,
                distFromVwap,
                rsi14,
                atr14,
                atrPct,
                recentSwingHigh: findSwingHigh(candles),
                recentSwingLow: findSwingLow(candles),
                consecutiveGreen,
                consecutiveRed,
                volumeTrend: volumeTrend(candles),
            },

            patterns: {
                available: false,
                topPattern: null,
            },

            liquidityZones: {
                available: false,
                nearestSupport: null,
                nearestResistance: null,
            },

            scenarios: {
                available: scenarios.length > 0,
                bull: bullSc
                    ? { probability: bullSc.probability, finalPrice: bullSc.finalPrice }
                    : null,
                base: baseSc
                    ? { probability: baseSc.probability, finalPrice: baseSc.finalPrice }
                    : null,
                bear: bearSc
                    ? { probability: bearSc.probability, finalPrice: bearSc.finalPrice }
                    : null,
            },

            position: {
                hasPosition,
                direction: null,
                qty: 0,
                entryPrice: null,
                unrealizedPnl: 0,
                unrealizedPnlPct: 0,
            },

            portfolio: {
                equity,
                cashAvailable,
                cashPct,
            },
        };

        setContext(ctx);
        setLastUpdated(Date.now());
    }, [pairId, pairSymbol, timeframe, enabled]);

    useEffect(() => {
        mountedRef.current = true;
        if (!pairId || !enabled) return;

        refresh();
        const interval = setInterval(refresh, 15_000);
        return () => {
            mountedRef.current = false;
            clearInterval(interval);
        };
    }, [pairId, timeframe, enabled, refresh]);

    return { context, loading: !context && enabled, lastUpdated };
}
