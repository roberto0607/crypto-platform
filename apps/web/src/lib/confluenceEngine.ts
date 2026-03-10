import type { Candle } from "@/api/endpoints/candles";
import type { OrderBlock } from "./orderBlocks";
import type { FairValueGap } from "./fairValueGaps";
import type { CvdDivergence } from "./cvd";
import type { LiquidityZone } from "@/api/endpoints/signals";

export interface ConfluenceSignal {
    name: string;
    direction: "long" | "short";
    strength: number;   // 0-100
    entryZone?: { low: number; high: number };
    slLevel?: number;
    tpLevel?: number;
}

export interface TradeSetup {
    direction: "long" | "short";
    confidence: number;
    entryZone: { low: number; high: number };
    stopLoss: number;
    tp1: number;
    tp2: number | null;
    tp3: number | null;
    rrRatio: number;
    agreeingSignals: ConfluenceSignal[];
    conflictingSignals: ConfluenceSignal[];
    reasoning: string;
}

interface ConfluenceContext {
    candles: Candle[];
    orderBlocks: OrderBlock[];
    fvgs: FairValueGap[];
    cvdDivergences: CvdDivergence[];
    liquidityZones: LiquidityZone[];
    keyLevels: { pdh: number; pdl: number } | null;
    fundingRate: number;
    currentPrice: number;
}

/**
 * Compute ATR from candles for stop-loss buffer.
 */
function computeAtr(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 0;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const c = candles[i]!;
        const prev = candles[i - 1]!;
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const prevClose = parseFloat(prev.close);
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        sum += tr;
    }
    return sum / period;
}

/**
 * Compute a trade setup from all indicator inputs.
 * Returns null when signals conflict (< 3 agree on direction).
 */
export function computeTradeSetup(ctx: ConfluenceContext): TradeSetup | null {
    const { currentPrice, orderBlocks, fvgs, cvdDivergences, liquidityZones, keyLevels, fundingRate, candles } = ctx;

    if (currentPrice <= 0 || candles.length < 20) return null;

    const signals: ConfluenceSignal[] = [];
    const atr = computeAtr(candles);
    if (atr <= 0) return null;

    // 1. Order Blocks near current price
    for (const ob of orderBlocks) {
        const distance = ob.type === "bullish"
            ? (currentPrice - ob.top) / currentPrice
            : (ob.bottom - currentPrice) / currentPrice;

        // OB is relevant if price is within 2% of it
        if (Math.abs(distance) < 0.02) {
            if (ob.type === "bullish" && currentPrice >= ob.bottom && currentPrice <= ob.top * 1.005) {
                signals.push({
                    name: "OB Support",
                    direction: "long",
                    strength: 80,
                    entryZone: { low: ob.bottom, high: ob.top },
                    slLevel: ob.bottom - atr * 0.5,
                });
            } else if (ob.type === "bearish" && currentPrice >= ob.bottom * 0.995 && currentPrice <= ob.top) {
                signals.push({
                    name: "OB Resistance",
                    direction: "short",
                    strength: 80,
                    entryZone: { low: ob.bottom, high: ob.top },
                    slLevel: ob.top + atr * 0.5,
                });
            }
        }
    }

    // 2. Fair Value Gaps near current price
    for (const gap of fvgs) {
        const gapMid = (gap.top + gap.bottom) / 2;
        const distance = Math.abs(currentPrice - gapMid) / currentPrice;

        if (distance < 0.015) {
            if (gap.type === "bullish" && currentPrice <= gap.top) {
                signals.push({
                    name: "FVG Fill",
                    direction: "long",
                    strength: 65,
                    entryZone: { low: gap.bottom, high: gap.top },
                });
            } else if (gap.type === "bearish" && currentPrice >= gap.bottom) {
                signals.push({
                    name: "FVG Fill",
                    direction: "short",
                    strength: 65,
                    entryZone: { low: gap.bottom, high: gap.top },
                });
            }
        }
    }

    // 3. CVD Divergences (most recent)
    if (cvdDivergences.length > 0) {
        const latest = cvdDivergences[cvdDivergences.length - 1]!;
        const recency = Date.now() / 1000 - latest.endTime;
        // Only consider divergences from the last 50 candles
        if (recency < 50 * 3600) {
            signals.push({
                name: "CVD Divergence",
                direction: latest.type === "bullish" ? "long" : "short",
                strength: 75,
            });
        }
    }

    // 4. Liquidity zones
    const supports = liquidityZones.filter((z) => z.type === "support");
    const resistances = liquidityZones.filter((z) => z.type === "resistance");

    for (const zone of supports) {
        const dist = (currentPrice - zone.price) / currentPrice;
        if (dist >= -0.005 && dist <= 0.01) {
            signals.push({
                name: "Liquidity Support",
                direction: "long",
                strength: zone.strength,
                entryZone: { low: zone.price - zone.width / 2, high: zone.price + zone.width / 2 },
                slLevel: zone.price - zone.width,
            });
        }
    }

    for (const zone of resistances) {
        const dist = (zone.price - currentPrice) / currentPrice;
        if (dist >= -0.005 && dist <= 0.01) {
            signals.push({
                name: "Liquidity Resistance",
                direction: "short",
                strength: zone.strength,
                entryZone: { low: zone.price - zone.width / 2, high: zone.price + zone.width / 2 },
                slLevel: zone.price + zone.width,
            });
        }
    }

    // 5. Key Levels (PDH/PDL)
    if (keyLevels) {
        const distFromPdl = (currentPrice - keyLevels.pdl) / currentPrice;
        const distFromPdh = (keyLevels.pdh - currentPrice) / currentPrice;

        if (distFromPdl >= -0.003 && distFromPdl <= 0.005) {
            signals.push({
                name: "PDL Support",
                direction: "long",
                strength: 60,
                slLevel: keyLevels.pdl - atr,
            });
        }
        if (distFromPdh >= -0.003 && distFromPdh <= 0.005) {
            signals.push({
                name: "PDH Resistance",
                direction: "short",
                strength: 60,
                slLevel: keyLevels.pdh + atr,
            });
        }
    }

    // 6. Funding rate (contrarian)
    if (Math.abs(fundingRate) > 0.0005) {
        signals.push({
            name: fundingRate > 0 ? "Funding Bearish" : "Funding Bullish",
            direction: fundingRate > 0 ? "short" : "long",
            strength: Math.min(Math.abs(fundingRate) * 10000, 70),
        });
    }

    // Count votes by direction
    const longSignals = signals.filter((s) => s.direction === "long");
    const shortSignals = signals.filter((s) => s.direction === "short");

    const minConfluence = 3;

    let direction: "long" | "short";
    let agreeingSignals: ConfluenceSignal[];
    let conflictingSignals: ConfluenceSignal[];

    if (longSignals.length >= minConfluence && longSignals.length > shortSignals.length) {
        direction = "long";
        agreeingSignals = longSignals;
        conflictingSignals = shortSignals;
    } else if (shortSignals.length >= minConfluence && shortSignals.length > longSignals.length) {
        direction = "short";
        agreeingSignals = shortSignals;
        conflictingSignals = longSignals;
    } else {
        return null; // No clear setup — signals conflict
    }

    // Compute entry zone from agreeing signals
    const entryZones = agreeingSignals.filter((s) => s.entryZone).map((s) => s.entryZone!);
    let entryZone: { low: number; high: number };
    if (entryZones.length > 0) {
        entryZone = {
            low: Math.min(...entryZones.map((z) => z.low)),
            high: Math.max(...entryZones.map((z) => z.high)),
        };
    } else {
        entryZone = { low: currentPrice * 0.998, high: currentPrice * 1.002 };
    }

    // Compute stop loss
    const slLevels = agreeingSignals.filter((s) => s.slLevel).map((s) => s.slLevel!);
    let stopLoss: number;
    if (direction === "long") {
        stopLoss = slLevels.length > 0
            ? Math.min(...slLevels)
            : entryZone.low - atr * 1.5;
    } else {
        stopLoss = slLevels.length > 0
            ? Math.max(...slLevels)
            : entryZone.high + atr * 1.5;
    }

    // Compute take-profit targets from opposing liquidity
    const entryMid = (entryZone.low + entryZone.high) / 2;
    const risk = Math.abs(entryMid - stopLoss);

    let tp1: number;
    let tp2: number | null = null;
    let tp3: number | null = null;

    if (direction === "long") {
        // Target resistance zones / buy-side liquidity
        const targets = resistances
            .filter((z) => z.price > currentPrice)
            .sort((a, b) => a.price - b.price);

        tp1 = targets.length > 0 ? targets[0]!.price : entryMid + risk * 2;
        tp2 = targets.length > 1 ? targets[1]!.price : (risk > 0 ? entryMid + risk * 3 : null);
        tp3 = targets.length > 2 ? targets[2]!.price : null;

        // Ensure minimum 2:1 R:R for TP1
        if (tp1 - entryMid < risk * 2) tp1 = entryMid + risk * 2;
    } else {
        // Target support zones / sell-side liquidity
        const targets = supports
            .filter((z) => z.price < currentPrice)
            .sort((a, b) => b.price - a.price);

        tp1 = targets.length > 0 ? targets[0]!.price : entryMid - risk * 2;
        tp2 = targets.length > 1 ? targets[1]!.price : (risk > 0 ? entryMid - risk * 3 : null);
        tp3 = targets.length > 2 ? targets[2]!.price : null;

        if (entryMid - tp1 < risk * 2) tp1 = entryMid - risk * 2;
    }

    const rrRatio = risk > 0 ? Math.round(Math.abs(tp1 - entryMid) / risk * 10) / 10 : 0;

    // Confidence = weighted average of agreeing signal strengths
    const totalStrength = agreeingSignals.reduce((sum, s) => sum + s.strength, 0);
    const confidence = Math.round(totalStrength / agreeingSignals.length);

    // One-line reasoning
    const reasoning = agreeingSignals.map((s) => s.name).join(" + ");

    return {
        direction,
        confidence,
        entryZone,
        stopLoss,
        tp1,
        tp2,
        tp3,
        rrRatio,
        agreeingSignals,
        conflictingSignals,
        reasoning,
    };
}
