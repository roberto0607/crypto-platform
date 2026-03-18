/**
 * regimeClassifier.ts — Market regime detection engine.
 *
 * Classifies the current market into one of 4 regimes:
 *   TRENDING — directional moves, ride momentum
 *   RANGING — sideways, mean reversion, fade extremes
 *   VOLATILE — noise dominates, reduce exposure
 *   MANIPULATED — order book spoofing, discount flow signals
 *   TRANSITIONING — regime unclear, balanced approach
 *
 * Polls every 5 minutes. Reads from all 5 Phase 1 streams +
 * Coinbase hourly candles for price action analysis.
 */

import { getCurrentBasis } from "./perpetualBasisService";
import { getCurrentOrderBookSignal } from "./orderBookAggregator";
import { getCurrentGammaSignal } from "./optionsGammaService";

// ── Types ──

interface Candle {
    start: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface PriceAction {
    atrPercent: number;
    priceChange24h: number;
    priceChange48h: number;
    consecutiveDirectional: number;
    isCompressing: boolean;
    volRegime: string;
    volExpanding: boolean;
}

interface RegimeScores {
    trending: number;
    ranging: number;
    volatile: number;
    manipulated: number;
}

interface ManipulationFlags {
    spoofingDetected: boolean;
    extremeFunding: boolean;
}

interface AdjustedWeights {
    basis: number;
    orderBook: number;
    macro: number;
    gamma: number;
    onChain: number;
}

interface RegimeSnapshot {
    timestamp: number;
    regime: string;
    regimeConfidence: number;
    description: string;
    scores: RegimeScores;
    priceAction: PriceAction;
    manipulationFlags: ManipulationFlags;
    adjustedWeights: AdjustedWeights;
    weightingReasoning: string;
    confidenceMultiplier: number;
    tradeRecommendation: string;
}

// ── Constants ──

const POLL_MS = 5 * 60_000;
const LOG_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// ── State ──

let cached: RegimeSnapshot | null = null;
let cachedCandles: Candle[] = [];
let lastLogTime = 0;
let interval: ReturnType<typeof setInterval> | null = null;

// ── Coinbase candle fetcher ──

async function fetchHourlyCandles(): Promise<Candle[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(
            "https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?granularity=ONE_HOUR&limit=48",
            { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`Coinbase candles: ${res.status}`);
        const json = (await res.json()) as {
            candles: { start: string; low: string; high: string; open: string; close: string; volume: string }[];
        };
        return json.candles.map((c) => ({
            start: parseInt(c.start, 10),
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            volume: parseFloat(c.volume),
        })).reverse(); // oldest first
    } catch (err) {
        console.warn("[Regime] Coinbase candles error:", (err as Error).message);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

// ── Step 1: Price action metrics ──

function calcPriceAction(candles: Candle[]): PriceAction {
    if (candles.length < 3) {
        return {
            atrPercent: 0, priceChange24h: 0, priceChange48h: 0,
            consecutiveDirectional: 0, isCompressing: false,
            volRegime: "NORMAL", volExpanding: false,
        };
    }

    const currentPrice = candles[candles.length - 1]!.close;

    // True range
    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i]!;
        const prevClose = candles[i - 1]!.close;
        trueRanges.push(Math.max(
            c.high - c.low,
            Math.abs(c.high - prevClose),
            Math.abs(c.low - prevClose),
        ));
    }

    // ATR14
    const atr14Slice = trueRanges.slice(-14);
    const atr14 = atr14Slice.length > 0
        ? atr14Slice.reduce((s, v) => s + v, 0) / atr14Slice.length : 0;
    const atrPercent = currentPrice > 0 ? (atr14 / currentPrice) * 100 : 0;

    // Price changes
    const idx24 = Math.max(0, candles.length - 25);
    const idx48 = 0;
    const priceChange24h = candles[idx24]!.close > 0
        ? ((currentPrice - candles[idx24]!.close) / candles[idx24]!.close) * 100 : 0;
    const priceChange48h = candles[idx48]!.close > 0
        ? ((currentPrice - candles[idx48]!.close) / candles[idx48]!.close) * 100 : 0;

    // Consecutive directional candles (last 6)
    const last6 = candles.slice(-6);
    let greenCount = 0;
    let redCount = 0;
    for (const c of last6) {
        if (c.close >= c.open) greenCount++;
        else redCount++;
    }
    const consecutiveDirectional = Math.max(greenCount, redCount);

    // Price range compression
    const last24 = candles.slice(-24);
    const last48 = candles;
    const high24 = Math.max(...last24.map((c) => c.high));
    const low24 = Math.min(...last24.map((c) => c.low));
    const high48 = Math.max(...last48.map((c) => c.high));
    const low48 = Math.min(...last48.map((c) => c.low));
    const highLow24h = currentPrice > 0 ? ((high24 - low24) / currentPrice) * 100 : 0;
    const highLow48h = currentPrice > 0 ? ((high48 - low48) / currentPrice) * 100 : 0;
    const isCompressing = highLow48h > 0 && highLow24h < highLow48h * 0.6;

    // Volatility regime
    let volRegime: string;
    if (atrPercent > 3.0) volRegime = "EXTREME";
    else if (atrPercent > 1.5) volRegime = "HIGH";
    else if (atrPercent > 0.8) volRegime = "NORMAL";
    else volRegime = "LOW";

    // Volatility expansion
    const recentATR = trueRanges.slice(-3);
    const recentAvg = recentATR.length > 0
        ? recentATR.reduce((s, v) => s + v, 0) / recentATR.length : 0;
    const historicalAvg = atr14;
    const volExpanding = historicalAvg > 0 && (recentAvg / historicalAvg) > 1.5;

    return {
        atrPercent: Math.round(atrPercent * 1000) / 1000,
        priceChange24h: Math.round(priceChange24h * 100) / 100,
        priceChange48h: Math.round(priceChange48h * 100) / 100,
        consecutiveDirectional,
        isCompressing,
        volRegime,
        volExpanding,
    };
}

// ── Step 3: Manipulation detection ──

function detectManipulation(): ManipulationFlags {
    const obData = getCurrentOrderBookSignal();
    const basisData = getCurrentBasis();

    let spoofingDetected = false;
    if (obData) {
        spoofingDetected =
            !obData.combined.agreement &&
            (obData.coinbase.imbalanceRatio > 0.65 || obData.coinbase.imbalanceRatio < 0.35) &&
            obData.combined.confidence < 0.3;
    }

    let extremeFunding = false;
    if (basisData) {
        extremeFunding = Math.abs(basisData.fundingRateAnnualized) > 100;
    }

    return { spoofingDetected, extremeFunding };
}

// ── Step 4: Classify regime ──

function classifyRegime(
    pa: PriceAction,
    manip: ManipulationFlags,
): { regime: string; scores: RegimeScores; confidence: number } {
    const gammaData = getCurrentGammaSignal();

    // TRENDING score
    let trending = 0;
    if (Math.abs(pa.priceChange24h) > 2) trending += 30;
    if (pa.consecutiveDirectional >= 4) trending += 20;
    if (Math.abs(pa.priceChange48h) > 4) trending += 20;
    if (pa.volRegime === "NORMAL" || pa.volRegime === "HIGH") trending += 15;
    if (!pa.isCompressing) trending += 15;

    // RANGING score
    let ranging = 0;
    if (Math.abs(pa.priceChange24h) < 1) ranging += 30;
    if (pa.isCompressing) ranging += 25;
    if (pa.consecutiveDirectional <= 2) ranging += 20;
    if (pa.volRegime === "LOW" || pa.volRegime === "NORMAL") ranging += 15;
    if (gammaData) {
        const ms = gammaData.marketStructure;
        if (ms === "PINNED_TO_MAX_PAIN" || ms === "BETWEEN_WALLS") ranging += 10;
    }

    // VOLATILE score
    let volatile = 0;
    if (pa.volRegime === "EXTREME") volatile += 40;
    if (pa.volExpanding && pa.atrPercent > 1.5) volatile += 30;
    if (Math.abs(pa.priceChange24h) > 5) volatile += 20;
    if (manip.extremeFunding) volatile += 10;

    // MANIPULATED score
    let manipulated = 0;
    if (manip.spoofingDetected) manipulated += 50;
    if (manip.extremeFunding) manipulated += 30;
    const obData = getCurrentOrderBookSignal();
    if (obData && obData.combined.signal === "MIXED" && Math.abs(pa.priceChange24h) < 0.5) {
        manipulated += 20;
    }

    const scores: RegimeScores = { trending, ranging, volatile, manipulated };

    // Find winner
    const entries = Object.entries(scores) as [string, number][];
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries[0]!;
    const second = entries[1]!;

    let regime: string;
    let confidence: number;

    if (top[1] - second[1] < 15) {
        regime = "TRANSITIONING";
        confidence = top[1] / 100 * 0.5; // halved confidence for transitioning
    } else {
        regime = top[0].toUpperCase();
        confidence = top[1] / 100;
    }

    return { regime, scores, confidence: Math.min(confidence, 1) };
}

// ── Step 5: Regime-adjusted weights ──

interface WeightResult {
    weights: AdjustedWeights;
    reasoning: string;
    confidenceMultiplier: number;
    tradeRecommendation: string;
}

function getRegimeWeights(regime: string): WeightResult {
    switch (regime) {
        case "TRENDING":
            return {
                weights: { basis: 0.30, orderBook: 0.35, macro: 0.10, gamma: 0.15, onChain: 0.10 },
                reasoning: "Momentum and order flow dominate in trends. Gamma levels less relevant.",
                confidenceMultiplier: 1.0,
                tradeRecommendation: "FAVORABLE — signals clear, regime defined",
            };
        case "RANGING":
            return {
                weights: { basis: 0.20, orderBook: 0.20, macro: 0.15, gamma: 0.35, onChain: 0.10 },
                reasoning: "Gamma gravity wells and max pain dominate in ranges. Mean reversion rules.",
                confidenceMultiplier: 1.0,
                tradeRecommendation: "WAIT — ranging, wait for breakout confirmation",
            };
        case "VOLATILE":
            return {
                weights: { basis: 0.15, orderBook: 0.15, macro: 0.20, gamma: 0.20, onChain: 0.30 },
                reasoning: "All short-term signals are noise. On-chain fundamentals matter most. Reduce all scores by 50% — low confidence environment.",
                confidenceMultiplier: 0.5,
                tradeRecommendation: "AVOID — volatile or manipulated market",
            };
        case "MANIPULATED":
            return {
                weights: { basis: 0.30, orderBook: 0.10, macro: 0.15, gamma: 0.25, onChain: 0.20 },
                reasoning: "Order book is being spoofed. Discount it heavily. Trust gamma and on-chain.",
                confidenceMultiplier: 0.7,
                tradeRecommendation: "AVOID — volatile or manipulated market",
            };
        default: // TRANSITIONING
            return {
                weights: { basis: 0.25, orderBook: 0.25, macro: 0.15, gamma: 0.20, onChain: 0.15 },
                reasoning: "Regime unclear. Use balanced weights.",
                confidenceMultiplier: 0.8,
                tradeRecommendation: "CAUTION — regime transitioning",
            };
    }
}

// ── Regime description ──

function describeRegime(regime: string, pa: PriceAction, manip: ManipulationFlags): string {
    switch (regime) {
        case "TRENDING":
            const dir = pa.priceChange24h >= 0 ? "upward" : "downward";
            return `Market is trending ${dir}. Price moved ${Math.abs(pa.priceChange24h).toFixed(1)}% in 24h with ${pa.consecutiveDirectional}/6 directional candles. Momentum signals are reliable — ride the trend.`;
        case "RANGING":
            return `Market is range-bound. Price changed only ${Math.abs(pa.priceChange24h).toFixed(1)}% in 24h${pa.isCompressing ? " and volatility is compressing" : ""}. Gamma gravity wells and max pain are pulling price. Mean reversion strategies favored.`;
        case "VOLATILE":
            return `Market is highly volatile (ATR ${pa.atrPercent.toFixed(1)}%). Short-term signals are unreliable. On-chain fundamentals and macro factors are more trustworthy. Reduce position sizing.`;
        case "MANIPULATED":
            return `Manipulation signals detected${manip.spoofingDetected ? " — order book spoofing across exchanges" : ""}${manip.extremeFunding ? " — extreme funding rates indicate forced positioning" : ""}. Discount order book data. Trust structural levels and on-chain flows.`;
        default:
            return `Market is transitioning between regimes. Multiple classification scores are close. Use balanced weights and wait for clearer conditions.`;
    }
}

// ── Poll ──

async function poll(): Promise<void> {
    try {
        const candles = await fetchHourlyCandles();
        if (candles.length > 0) {
            cachedCandles = candles;
        }

        if (cachedCandles.length < 3) {
            cached = {
                timestamp: Date.now(),
                regime: "TRANSITIONING",
                regimeConfidence: 0,
                description: "Insufficient price data to classify regime.",
                scores: { trending: 0, ranging: 0, volatile: 0, manipulated: 0 },
                priceAction: {
                    atrPercent: 0, priceChange24h: 0, priceChange48h: 0,
                    consecutiveDirectional: 0, isCompressing: false,
                    volRegime: "NORMAL", volExpanding: false,
                },
                manipulationFlags: { spoofingDetected: false, extremeFunding: false },
                adjustedWeights: { basis: 0.25, orderBook: 0.25, macro: 0.15, gamma: 0.20, onChain: 0.15 },
                weightingReasoning: "Insufficient data — using balanced defaults.",
                confidenceMultiplier: 0.5,
                tradeRecommendation: "CAUTION — regime transitioning",
            };
            return;
        }

        const pa = calcPriceAction(cachedCandles);
        const manip = detectManipulation();
        const { regime, scores, confidence } = classifyRegime(pa, manip);
        const { weights, reasoning, confidenceMultiplier, tradeRecommendation } = getRegimeWeights(regime);
        const description = describeRegime(regime, pa, manip);

        cached = {
            timestamp: Date.now(),
            regime,
            regimeConfidence: Math.round(confidence * 100) / 100,
            description,
            scores,
            priceAction: pa,
            manipulationFlags: manip,
            adjustedWeights: weights,
            weightingReasoning: reasoning,
            confidenceMultiplier,
            tradeRecommendation,
        };

        if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
            console.log(
                `[Regime] ${regime} (confidence: ${(confidence * 100).toFixed(0)}%) | ` +
                `ATR: ${pa.atrPercent.toFixed(2)}% | ` +
                `24h: ${pa.priceChange24h >= 0 ? "+" : ""}${pa.priceChange24h.toFixed(2)}% | ` +
                `Spoofing: ${manip.spoofingDetected} | ` +
                `Rec: ${tradeRecommendation}`,
            );
            lastLogTime = Date.now();
        }
    } catch (err) {
        console.warn("[Regime] Poll error:", (err as Error).message);
    }
}

// ── Public API ──

export function getCurrentRegime(): RegimeSnapshot | null {
    return cached;
}

export function initRegimeClassifier(): void {
    if (interval) return;
    console.log("[Regime] Classifier initialized, polling every 5m");
    poll();
    interval = setInterval(poll, POLL_MS);
}

export function stopRegimeClassifier(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
