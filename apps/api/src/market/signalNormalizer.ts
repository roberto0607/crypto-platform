/**
 * signalNormalizer.ts — Signal normalization engine.
 *
 * Reads all 5 Phase 1 data streams and converts each into a
 * standardized directional score between -1.0 (max bearish) and
 * +1.0 (max bullish). Combines them with dynamic weighting.
 *
 * On-demand — no polling. Each call reads cached state from the
 * 5 existing services and normalizes fresh.
 */

import { getCurrentBasis } from "./perpetualBasisService";
import { getCurrentOrderBookSignal } from "./orderBookAggregator";
import { getCurrentMacro } from "./macroCorrelationService";
import { getCurrentGammaSignal } from "./optionsGammaService";
import { getCurrentOnChainSignal } from "./onChainFlowService";

// ── Types ──

export interface NormalizedSignals {
    timestamp: number;
    scores: {
        basis: number;
        orderBook: number;
        macro: number;
        gamma: number;
        onChain: number;
        weighted: number;
    };
    weights: {
        basis: number;
        orderBook: number;
        macro: number;
        gamma: number;
        onChain: number;
    };
    signal: {
        label: string;
        score: number;
        convergence: string;
        agreement: number;
        streamsAgreeing: number;
    };
    macroRelevance: number;
    rawInputs: {
        basisPercent: number;
        orderBookImbalance: number;
        macroRegime: string;
        marketStructure: string;
        onChainSmartMoney: string;
    };
}

// ── Helpers ──

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

// ── Stream 1: Perp Basis Score ──

function normalizeBasis(): { score: number; basisPercent: number } {
    const data = getCurrentBasis();
    if (!data) return { score: 0, basisPercent: 0 };

    let score = clamp(data.basisPercent * -10, -1, 1);

    // Crowding overrides
    if (data.crowding === "LONGS_CROWDED") score = Math.min(score, -0.6);
    if (data.crowding === "SHORTS_CROWDED") score = Math.max(score, 0.6);

    // Funding rate adjustment
    if (data.fundingRateAnnualized > 50) score -= 0.2;
    if (data.fundingRateAnnualized < -50) score += 0.2;

    return { score: clamp(score, -1, 1), basisPercent: data.basisPercent };
}

// ── Stream 2: Order Book Score ──

function normalizeOrderBook(): { score: number; imbalance: number } {
    const data = getCurrentOrderBookSignal();
    if (!data) return { score: 0, imbalance: 0.5 };

    const imbalance = data.combined.imbalanceRatio;
    let rawScore = (imbalance - 0.5) * 2;

    if (!data.combined.agreement) rawScore *= 0.3;

    const score = clamp(rawScore * data.combined.confidence, -1, 1);
    return { score, imbalance };
}

// ── Stream 3: Macro Score ──

function normalizeMacro(): { score: number; relevance: number; regime: string } {
    const data = getCurrentMacro();
    if (!data) return { score: 0, relevance: 0.1, regime: "UNAVAILABLE" };

    const regime = data.regime;

    // Relevance by regime
    const relevanceMap: Record<string, number> = {
        MACRO_DRIVEN: 1.0,
        DOLLAR_DRIVEN: 0.8,
        RISK_ASSET: 0.5,
        MIXED: 0.3,
        DECORRELATED: 0.1,
    };
    const relevance = relevanceMap[regime] ?? 0.1;

    if (regime === "DECORRELATED") {
        return { score: 0, relevance, regime };
    }

    let score = 0;

    if (regime === "MACRO_DRIVEN" || regime === "DOLLAR_DRIVEN") {
        if (data.dxyImpact === "HEADWIND") score = -0.5;
        if (data.dxyImpact === "TAILWIND") score = 0.5;

        if (data.dxyTrend === "STRENGTHENING") score -= 0.2;
        if (data.dxyTrend === "WEAKENING") score += 0.2;
    }

    if (regime === "RISK_ASSET") {
        score = data.correlations.btcQqq.pearson * 0.5;
    }

    return { score: clamp(score, -1, 1), relevance, regime };
}

// ── Stream 4: Gamma Score ──

function normalizeGamma(): { score: number; marketStructure: string } {
    const data = getCurrentGammaSignal();
    if (!data) return { score: 0, marketStructure: "UNAVAILABLE" };

    // Max pain pull
    let maxPainScore = 0;
    const distPct = (data.btcPrice - data.maxPain.strike) / data.btcPrice;
    if (Math.abs(distPct) < 0.03) {
        maxPainScore = -distPct * 10;
    }

    // Gamma flip
    const gammaFlipScore = data.gammaFlip.priceAboveFlip ? 0.2 : -0.2;

    // Net gamma regime
    const netGammaScore = data.netGamma.regime === "POSITIVE" ? 0.1 : 0;

    const score = clamp(maxPainScore + gammaFlipScore + netGammaScore, -1, 1);
    return { score, marketStructure: data.marketStructure };
}

// ── Stream 5: On-chain Score ──

function normalizeOnChain(): { score: number; smartMoney: string } {
    const data = getCurrentOnChainSignal();
    if (!data) return { score: 0, smartMoney: "UNAVAILABLE" };

    const baseMap: Record<string, number> = {
        ACCUMULATION: 0.6,
        DISTRIBUTION: -0.6,
        NEUTRAL: 0,
    };
    const baseScore = baseMap[data.smartMoneySignal] ?? 0;

    const multMap: Record<string, number> = {
        HIGH: 1.0,
        MEDIUM: 0.6,
        LOW: 0.3,
    };
    const multiplier = multMap[data.confidence] ?? 0.3;

    const score = clamp(baseScore * multiplier, -1, 1);
    return { score, smartMoney: data.smartMoneySignal };
}

// ── Combined Signal ──

function interpretLabel(score: number): string {
    if (score > 0.6) return "STRONG_BULL";
    if (score > 0.3) return "MODERATE_BULL";
    if (score > 0.1) return "SLIGHT_BULL";
    if (score >= -0.1) return "NEUTRAL";
    if (score > -0.3) return "SLIGHT_BEAR";
    if (score > -0.6) return "MODERATE_BEAR";
    return "STRONG_BEAR";
}

// ── Public API ──

export function getNormalizedSignals(): NormalizedSignals {
    const basis = normalizeBasis();
    const orderBook = normalizeOrderBook();
    const macro = normalizeMacro();
    const gamma = normalizeGamma();
    const onChain = normalizeOnChain();

    // Dynamic weighting — redistribute unused macro weight
    const baseMacroWeight = 0.15;
    const actualMacroWeight = baseMacroWeight * macro.relevance;
    const redistributed = (baseMacroWeight - actualMacroWeight) / 2;

    const weights = {
        basis: 0.25 + redistributed,
        orderBook: 0.25 + redistributed,
        macro: actualMacroWeight,
        gamma: 0.20,
        onChain: 0.15,
    };

    const weightedScore = clamp(
        basis.score * weights.basis +
        orderBook.score * weights.orderBook +
        macro.score * weights.macro +
        gamma.score * weights.gamma +
        onChain.score * weights.onChain,
        -1,
        1,
    );

    // Agreement: how many streams share the same sign as weighted
    const scores = [basis.score, orderBook.score, macro.score, gamma.score, onChain.score];
    const sign = weightedScore >= 0 ? 1 : -1;
    const streamsAgreeing = scores.filter((s) =>
        (sign >= 0 && s >= 0) || (sign < 0 && s < 0),
    ).length;
    const agreement = streamsAgreeing / 5;

    let convergence: string;
    if (agreement >= 0.8) convergence = "HIGH";
    else if (agreement >= 0.6) convergence = "MODERATE";
    else convergence = "LOW";

    const label = interpretLabel(weightedScore);

    console.log(
        `[SignalNorm] basis:${basis.score.toFixed(2)} ob:${orderBook.score.toFixed(2)} ` +
        `macro:${macro.score.toFixed(2)} gamma:${gamma.score.toFixed(2)} ` +
        `onchain:${onChain.score.toFixed(2)} → weighted:${weightedScore.toFixed(3)} ` +
        `(${label}) conv:${convergence}`,
    );

    return {
        timestamp: Date.now(),
        scores: {
            basis: Math.round(basis.score * 1000) / 1000,
            orderBook: Math.round(orderBook.score * 1000) / 1000,
            macro: Math.round(macro.score * 1000) / 1000,
            gamma: Math.round(gamma.score * 1000) / 1000,
            onChain: Math.round(onChain.score * 1000) / 1000,
            weighted: Math.round(weightedScore * 1000) / 1000,
        },
        weights: {
            basis: Math.round(weights.basis * 1000) / 1000,
            orderBook: Math.round(weights.orderBook * 1000) / 1000,
            macro: Math.round(weights.macro * 1000) / 1000,
            gamma: Math.round(weights.gamma * 1000) / 1000,
            onChain: Math.round(weights.onChain * 1000) / 1000,
        },
        signal: {
            label,
            score: Math.round(weightedScore * 1000) / 1000,
            convergence,
            agreement: Math.round(agreement * 100) / 100,
            streamsAgreeing,
        },
        macroRelevance: macro.relevance,
        rawInputs: {
            basisPercent: basis.basisPercent,
            orderBookImbalance: orderBook.imbalance,
            macroRegime: macro.regime,
            marketStructure: gamma.marketStructure,
            onChainSmartMoney: onChain.smartMoney,
        },
    };
}
