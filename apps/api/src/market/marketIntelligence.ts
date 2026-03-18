/**
 * marketIntelligence.ts — Unified market intelligence synthesis.
 *
 * Single master endpoint that combines all Phase 1 streams + Phase 2
 * normalization + regime classification into one unified response.
 * One API call = everything the frontend needs.
 *
 * No polling — reads cached state from all services on each call.
 */

import { getCurrentBasis } from "./perpetualBasisService";
import { getCurrentOrderBookSignal } from "./orderBookAggregator";
import { getCurrentMacro } from "./macroCorrelationService";
import { getCurrentGammaSignal } from "./optionsGammaService";
import { getCurrentOnChainSignal } from "./onChainFlowService";
import { getNormalizedSignals } from "./signalNormalizer";
import { getCurrentRegime } from "./regimeClassifier";
import { shouldLog, logSignal, getSignalCount } from "./signalLogger";
import { getLearnedWeights } from "./weightAdjuster";

// ── Types ──

interface KeyLevel {
    price: number;
    type: string;
    distance: number;
    distancePercent: number;
    significance: string;
}

interface Alert {
    type: string;
    severity: string;
    message: string;
}

interface MarketIntelligence {
    timestamp: number;
    version: string;
    headline: {
        action: string;
        actionReason: string;
        score: number;
        scoreLabel: string;
        strength: string;
        confidence: number;
        regime: string;
        regimeConfidence: number;
    };
    streams: {
        basis: { score: number; label: string; keyData: string };
        orderBook: { score: number; label: string; keyData: string };
        macro: { score: number; label: string; keyData: string; relevance: number };
        gamma: { score: number; label: string; keyData: string };
        onChain: { score: number; label: string; keyData: string };
    };
    weights: {
        basis: number;
        orderBook: number;
        macro: number;
        gamma: number;
        onChain: number;
        regimeApplied: string;
    };
    keyLevels: KeyLevel[];
    alerts: Alert[];
    convergence: {
        level: string;
        streamsAgreeing: number;
        agreement: number;
    };
    rawSnapshot: {
        btcPrice: number;
        basisPercent: number;
        orderBookSignal: string;
        macroRegime: string;
        marketStructure: string;
        onChainSignal: string;
        atrPercent: number;
        maxPainStrike: number;
        gammaFlipStrike: number;
    };
    learning: {
        source: "learned" | "base";
        sampleSize: number;
        totalSignals: number;
        gradedSignals: number;
    };
}

// ── Helpers ──

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function scoreLabel(s: number): string {
    if (s > 0.6) return "STRONG_BULL";
    if (s > 0.3) return "MODERATE_BULL";
    if (s > 0.1) return "SLIGHT_BULL";
    if (s >= -0.1) return "NEUTRAL";
    if (s > -0.3) return "SLIGHT_BEAR";
    if (s > -0.6) return "MODERATE_BEAR";
    return "STRONG_BEAR";
}

function strengthLabel(s: number): string {
    const abs = Math.abs(s);
    if (abs > 0.7) return "VERY_STRONG";
    if (abs > 0.5) return "STRONG";
    if (abs > 0.3) return "MODERATE";
    if (abs > 0.1) return "WEAK";
    return "NEGLIGIBLE";
}

function streamLabel(s: number): string {
    if (s > 0.3) return "bullish";
    if (s > 0.1) return "slightly bullish";
    if (s >= -0.1) return "neutral";
    if (s > -0.3) return "slightly bearish";
    return "bearish";
}

function r(v: number, decimals = 3): number {
    const f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
}

// ── Action guidance ──

function deriveAction(regime: string, finalScore: number): { action: string; reason: string } {
    if (regime === "VOLATILE") {
        return {
            action: "STAND_ASIDE",
            reason: "Volatile market — all signals unreliable. Wait for conditions to stabilize.",
        };
    }

    if (regime === "MANIPULATED") {
        return {
            action: "STAND_ASIDE",
            reason: "Order book manipulation detected. Trust gamma and on-chain only.",
        };
    }

    if (regime === "RANGING") {
        if (finalScore > 0.3) return {
            action: "WAIT_FOR_BREAKOUT_LONG",
            reason: "Bullish signals in range. Wait for confirmed break above resistance.",
        };
        if (finalScore < -0.3) return {
            action: "WAIT_FOR_BREAKOUT_SHORT",
            reason: "Bearish signals in range. Wait for confirmed break below support.",
        };
        return {
            action: "WAIT",
            reason: "No directional edge. Market ranging with no clear catalyst.",
        };
    }

    if (regime === "TRENDING") {
        if (finalScore > 0.5) return {
            action: "LONG_FAVORABLE",
            reason: "Strong bullish confluence in trending market. High probability setup.",
        };
        if (finalScore > 0.2) return {
            action: "LONG_POSSIBLE",
            reason: "Moderate bullish signals in trend. Requires confirmation.",
        };
        if (finalScore < -0.5) return {
            action: "SHORT_FAVORABLE",
            reason: "Strong bearish confluence in trending market. High probability setup.",
        };
        if (finalScore < -0.2) return {
            action: "SHORT_POSSIBLE",
            reason: "Moderate bearish signals in trend. Requires confirmation.",
        };
        return {
            action: "WAIT",
            reason: "Trending but no clear directional edge right now.",
        };
    }

    // TRANSITIONING or unknown
    return {
        action: "CAUTION",
        reason: "Regime shifting. Reduce size, wait for regime to clarify.",
    };
}

// ── Key levels builder ──

function buildKeyLevels(btcPrice: number): KeyLevel[] {
    const levels: KeyLevel[] = [];

    const gamma = getCurrentGammaSignal();
    if (gamma) {
        levels.push({
            price: gamma.maxPain.strike,
            type: "MAX_PAIN",
            distance: 0,
            distancePercent: 0,
            significance: gamma.maxPain.pullStrength === "STRONG" ? "HIGH" : "MEDIUM",
        });

        levels.push({
            price: gamma.gammaFlip.strike,
            type: "GAMMA_FLIP",
            distance: 0,
            distancePercent: 0,
            significance: "HIGH",
        });

        for (const kl of gamma.keyLevels) {
            levels.push({
                price: kl.strike,
                type: kl.type,
                distance: 0,
                distancePercent: 0,
                significance: Math.abs(kl.netGamma) > 5_000_000 ? "HIGH" : "MEDIUM",
            });
        }
    }

    const basis = getCurrentBasis();
    if (basis && (basis.crowding === "LONGS_CROWDED" || basis.crowding === "SHORTS_CROWDED")) {
        levels.push({
            price: Math.round(btcPrice),
            type: "CROWDING_LEVEL",
            distance: 0,
            distancePercent: 0,
            significance: "MEDIUM",
        });
    }

    // Deduplicate by price (keep first occurrence)
    const seen = new Set<number>();
    const unique: KeyLevel[] = [];
    for (const l of levels) {
        if (!seen.has(l.price)) {
            seen.add(l.price);
            unique.push(l);
        }
    }

    // Calculate distances and sort by proximity
    for (const l of unique) {
        l.distance = Math.round(btcPrice - l.price);
        l.distancePercent = btcPrice > 0 ? r(((btcPrice - l.price) / btcPrice) * 100, 2) : 0;
    }

    unique.sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
    return unique.slice(0, 5);
}

// ── Alerts builder ──

function buildAlerts(): Alert[] {
    const alerts: Alert[] = [];
    const regime = getCurrentRegime();
    const ob = getCurrentOrderBookSignal();
    const basis = getCurrentBasis();

    if (regime) {
        if (regime.manipulationFlags.spoofingDetected) {
            alerts.push({
                type: "SPOOFING",
                severity: "HIGH",
                message: "Order book divergence between exchanges suggests spoofing activity.",
            });
        }

        if (regime.manipulationFlags.extremeFunding) {
            alerts.push({
                type: "EXTREME_FUNDING",
                severity: "HIGH",
                message: "Annualized funding rate exceeds 100% — extreme positioning detected.",
            });
        }

        if (regime.priceAction.volExpanding) {
            alerts.push({
                type: "VOLATILITY_SPIKE",
                severity: "MEDIUM",
                message: `Volatility expanding — ATR at ${regime.priceAction.atrPercent.toFixed(1)}% (${regime.priceAction.volRegime}).`,
            });
        }
    }

    // Convergence alert
    const signals = getNormalizedSignals();
    if (signals.signal.convergence === "HIGH" && Math.abs(signals.scores.weighted) > 0.3) {
        alerts.push({
            type: "CONVERGENCE_HIGH",
            severity: "MEDIUM",
            message: `${signals.signal.streamsAgreeing}/5 streams agree on ${signals.scores.weighted > 0 ? "bullish" : "bearish"} direction.`,
        });
    }

    return alerts;
}

// ── Stream key data builders ──

function basisKeyData(): string {
    const d = getCurrentBasis();
    if (!d) return "Unavailable";
    return `Basis: ${d.basisPercent >= 0 ? "+" : ""}${d.basisPercent.toFixed(2)}%, ${d.crowding}`;
}

function orderBookKeyData(): string {
    const d = getCurrentOrderBookSignal();
    if (!d) return "Unavailable";
    const cb = (d.coinbase.imbalanceRatio * 100).toFixed(0);
    const kr = (d.kraken.imbalanceRatio * 100).toFixed(0);
    return `Coinbase ${cb}% / Kraken ${kr}% — ${d.combined.signal}`;
}

function macroKeyData(): string {
    const d = getCurrentMacro();
    if (!d) return "Unavailable";
    if (d.regime === "DECORRELATED") return "DECORRELATED — BTC independent";
    return `${d.regime} — DXY ${d.dxyTrend}, r(BTC,QQQ)=${d.correlations.btcQqq.pearson.toFixed(2)}`;
}

function gammaKeyData(): string {
    const d = getCurrentGammaSignal();
    if (!d) return "Unavailable";
    const topCall = d.keyLevels.find((l) => l.type === "CALL_WALL");
    return `Max pain $${(d.maxPain.strike / 1000).toFixed(0)}K${topCall ? `, Call wall $${(topCall.strike / 1000).toFixed(0)}K` : ""}, ${d.marketStructure}`;
}

function onChainKeyData(): string {
    const d = getCurrentOnChainSignal();
    if (!d) return "Unavailable";
    const volStr = d.volumeUsd >= 1e9
        ? `$${(d.volumeUsd / 1e9).toFixed(1)}B`
        : `$${(d.volumeUsd / 1e6).toFixed(0)}M`;
    const memStr = d.mempoolSize >= 1e6
        ? `${(d.mempoolSize / 1e6).toFixed(0)}MB mempool`
        : `${(d.mempoolSize / 1e3).toFixed(0)}KB mempool`;
    return `${d.smartMoneySignal} — ${volStr} volume, ${memStr}`;
}

// ── Master synthesis ──

export async function getMarketIntelligence(): Promise<MarketIntelligence> {
    const regime = getCurrentRegime();
    const signals = getNormalizedSignals();
    const macro = getCurrentMacro();
    const gamma = getCurrentGammaSignal();

    // Regime-adjusted weights
    const regimeName = regime?.regime ?? "TRANSITIONING";
    const regimeConf = regime?.regimeConfidence ?? 0;
    const confMult = regime?.confidenceMultiplier ?? 0.8;

    // Try learned weights first, fall back to regime-adjusted base weights
    const learned = await getLearnedWeights(regimeName);
    const adjWeights = learned.source === "learned"
        ? learned.weights
        : (regime?.adjustedWeights ?? {
            basis: 0.25, orderBook: 0.25, macro: 0.15, gamma: 0.20, onChain: 0.15,
        });

    // Re-calculate with regime-adjusted weights + macro relevance
    let wBasis = adjWeights.basis;
    let wOrderBook = adjWeights.orderBook;
    let wMacro = adjWeights.macro;
    const wGamma = adjWeights.gamma;
    const wOnChain = adjWeights.onChain;

    // Macro relevance adjustment
    const macroRelevance = signals.macroRelevance;
    const actualMacroWeight = wMacro * macroRelevance;
    const redistributed = (wMacro - actualMacroWeight) / 2;
    wBasis += redistributed;
    wOrderBook += redistributed;
    wMacro = actualMacroWeight;

    const rawWeightedScore =
        signals.scores.basis * wBasis +
        signals.scores.orderBook * wOrderBook +
        signals.scores.macro * wMacro +
        signals.scores.gamma * wGamma +
        signals.scores.onChain * wOnChain;

    const finalScore = clamp(rawWeightedScore * confMult, -1, 1);

    // Labels
    const label = scoreLabel(finalScore);
    const strength = strengthLabel(finalScore);

    // Action
    const { action, reason } = deriveAction(regimeName, finalScore);

    // Overall confidence = regime confidence × convergence agreement
    const overallConfidence = r(regimeConf * signals.signal.agreement, 2);

    // BTC price
    const btcPrice = gamma?.btcPrice ?? 0;

    // Key levels
    const keyLevels = buildKeyLevels(btcPrice);

    // Alerts
    const alerts = buildAlerts();

    console.log(
        `[Intelligence] score:${r(finalScore)} label:${label} regime:${regimeName} ` +
        `action:${action} confidence:${r(overallConfidence)} ` +
        `streams:${signals.signal.streamsAgreeing}/5 agreeing` +
        (learned.source === "learned" ? ` [LEARNED weights, n=${learned.sampleSize}]` : ""),
    );

    // Log signal to DB for outcome tracking (if score changed meaningfully)
    if (shouldLog(finalScore)) {
        logSignal({
            headline: {
                action,
                score: r(finalScore),
                scoreLabel: label,
                regime: regimeName,
                regimeConfidence: r(regimeConf),
            },
            streams: {
                basis: { score: signals.scores.basis },
                orderBook: { score: signals.scores.orderBook },
                macro: { score: signals.scores.macro },
                gamma: { score: signals.scores.gamma },
                onChain: { score: signals.scores.onChain },
            },
            convergence: {
                level: signals.signal.convergence,
                streamsAgreeing: signals.signal.streamsAgreeing,
            },
            weights: { basis: r(wBasis), orderBook: r(wOrderBook), macro: r(wMacro), gamma: r(wGamma), onChain: r(wOnChain) },
            rawSnapshot: { btcPrice: r(btcPrice, 2) },
        }).catch(() => { /* non-fatal */ });
    }

    // Get signal counts for learning status
    const signalCount = await getSignalCount().catch(() => ({ total: 0, graded: 0 }));

    return {
        timestamp: Date.now(),
        version: "1.0",

        headline: {
            action,
            actionReason: reason,
            score: r(finalScore),
            scoreLabel: label,
            strength,
            confidence: overallConfidence,
            regime: regimeName,
            regimeConfidence: r(regimeConf),
        },

        streams: {
            basis: {
                score: signals.scores.basis,
                label: streamLabel(signals.scores.basis),
                keyData: basisKeyData(),
            },
            orderBook: {
                score: signals.scores.orderBook,
                label: streamLabel(signals.scores.orderBook),
                keyData: orderBookKeyData(),
            },
            macro: {
                score: signals.scores.macro,
                label: streamLabel(signals.scores.macro),
                keyData: macroKeyData(),
                relevance: macroRelevance,
            },
            gamma: {
                score: signals.scores.gamma,
                label: streamLabel(signals.scores.gamma),
                keyData: gammaKeyData(),
            },
            onChain: {
                score: signals.scores.onChain,
                label: streamLabel(signals.scores.onChain),
                keyData: onChainKeyData(),
            },
        },

        weights: {
            basis: r(wBasis),
            orderBook: r(wOrderBook),
            macro: r(wMacro),
            gamma: r(wGamma),
            onChain: r(wOnChain),
            regimeApplied: regimeName,
        },

        keyLevels,

        alerts,

        convergence: {
            level: signals.signal.convergence,
            streamsAgreeing: signals.signal.streamsAgreeing,
            agreement: signals.signal.agreement,
        },

        rawSnapshot: {
            btcPrice: r(btcPrice, 2),
            basisPercent: signals.rawInputs.basisPercent
                ? r(signals.rawInputs.basisPercent, 4) : 0,
            orderBookSignal: signals.rawInputs.orderBookImbalance !== undefined
                ? `${r(signals.rawInputs.orderBookImbalance, 4)}` : "N/A",
            macroRegime: signals.rawInputs.macroRegime,
            marketStructure: signals.rawInputs.marketStructure,
            onChainSignal: signals.rawInputs.onChainSmartMoney,
            atrPercent: regime?.priceAction.atrPercent ?? 0,
            maxPainStrike: gamma?.maxPain.strike ?? 0,
            gammaFlipStrike: gamma?.gammaFlip.strike ?? 0,
        },

        learning: {
            source: learned.source,
            sampleSize: learned.sampleSize,
            totalSignals: signalCount.total,
            gradedSignals: signalCount.graded,
        },
    };
}
