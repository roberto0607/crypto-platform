import { pool } from "../db/pool.js";
import { getOrderFlow } from "./orderFlowFeatures.js";

interface SimpleCandle {
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface CandidateLevel {
    price: number;
    source: string;
    weight: number;
    recency: number; // 0-1, 1 = most recent
}

export interface LiquidityZone {
    price: number;
    width: number;
    strength: number;
    type: "support" | "resistance";
    sources: string[];
    estimatedLiquidity: string;
}

// ── Helpers ──

function computeATR(candles: SimpleCandle[], period: number): number {
    if (candles.length < 2) return 0;
    const trs: number[] = [candles[0]!.high - candles[0]!.low];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i]!;
        const prevClose = candles[i - 1]!.close;
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    }
    if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trs[i]!;
    let atr = sum / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]!) / period;
    }
    return atr;
}

function findSwingPoints(candles: SimpleCandle[], lookback: number = 3): { highs: number[]; lows: number[] } {
    const highs: number[] = [];
    const lows: number[] = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
        let isHigh = true;
        let isLow = true;
        const c = candles[i]!;

        for (let j = 1; j <= lookback; j++) {
            if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isHigh = false;
            if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isLow = false;
        }

        if (isHigh) highs.push(c.high);
        if (isLow) lows.push(c.low);
    }

    return { highs, lows };
}

function findEqualLevels(values: number[], tolerance: number): number[] {
    const levels: number[] = [];
    for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
            if (Math.abs(values[i]! - values[j]!) <= tolerance) {
                levels.push((values[i]! + values[j]!) / 2);
            }
        }
    }
    return levels;
}

function roundNumbers(currentPrice: number): number[] {
    const levels: number[] = [];

    // Determine magnitude-appropriate rounding
    let step: number;
    if (currentPrice > 10000) step = 1000;
    else if (currentPrice > 1000) step = 100;
    else if (currentPrice > 100) step = 10;
    else if (currentPrice > 10) step = 1;
    else step = 0.1;

    const base = Math.floor(currentPrice / step) * step;
    for (let i = -5; i <= 5; i++) {
        levels.push(base + i * step);
    }

    // Also add half-step levels
    const halfStep = step / 2;
    const halfBase = Math.floor(currentPrice / halfStep) * halfStep;
    for (let i = -3; i <= 3; i++) {
        const lvl = halfBase + i * halfStep;
        if (!levels.includes(lvl)) levels.push(lvl);
    }

    return levels;
}

// ── Main ──

export async function computeLiquidityZones(
    pairId: string,
    timeframe: string,
): Promise<{ zones: LiquidityZone[]; currentPrice: number }> {
    // Parallel fetch
    const [candleResult, orderFlow] = await Promise.all([
        pool.query<{
            ts: string; open: string; high: string; low: string;
            close: string; volume: string;
        }>(
            `SELECT ts, open, high, low, close, volume
             FROM candles
             WHERE pair_id = $1 AND timeframe = $2
             ORDER BY ts DESC LIMIT 300`,
            [pairId, timeframe],
        ),
        Promise.resolve(getOrderFlow(pairId)),
    ]);

    const candles: SimpleCandle[] = candleResult.rows.reverse().map((r) => ({
        ts: r.ts,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
    }));

    if (candles.length < 20) {
        return { zones: [], currentPrice: 0 };
    }

    const currentPrice = candles[candles.length - 1]!.close;
    const atr = computeATR(candles, 14);
    if (atr <= 0) return { zones: [], currentPrice };

    const candidates: CandidateLevel[] = [];
    const totalCandles = candles.length;

    // 1. Swing points (weight: 25)
    const swings = findSwingPoints(candles, 3);
    for (const h of swings.highs) {
        candidates.push({ price: h, source: "SW", weight: 25, recency: 0.7 });
    }
    for (const l of swings.lows) {
        candidates.push({ price: l, source: "SW", weight: 25, recency: 0.7 });
    }

    // 2. Equal highs/lows (weight: 30)
    const tolerance = atr * 0.15;
    const allHighs = candles.map((c) => c.high);
    const allLows = candles.map((c) => c.low);
    const eqHighs = findEqualLevels(allHighs, tolerance);
    const eqLows = findEqualLevels(allLows, tolerance);
    for (const lvl of eqHighs) {
        candidates.push({ price: lvl, source: "EQ", weight: 30, recency: 0.8 });
    }
    for (const lvl of eqLows) {
        candidates.push({ price: lvl, source: "EQ", weight: 30, recency: 0.8 });
    }

    // 3. Order flow walls (weight: 20)
    if (orderFlow) {
        if (orderFlow.bidWallPrice != null) {
            candidates.push({ price: orderFlow.bidWallPrice, source: "WL", weight: 20, recency: 1.0 });
        }
        if (orderFlow.askWallPrice != null) {
            candidates.push({ price: orderFlow.askWallPrice, source: "WL", weight: 20, recency: 1.0 });
        }
    }

    // 4. PDH/PDL (weight: 15) — use highest high and lowest low of previous day's candles
    const oneDayAgo = new Date(Date.now() - 86400_000);
    const prevDayCandles = candles.filter((c) => new Date(c.ts) < oneDayAgo);
    if (prevDayCandles.length > 0) {
        const pdh = Math.max(...prevDayCandles.map((c) => c.high));
        const pdl = Math.min(...prevDayCandles.map((c) => c.low));
        candidates.push({ price: pdh, source: "PD", weight: 15, recency: 0.6 });
        candidates.push({ price: pdl, source: "PD", weight: 15, recency: 0.6 });
    }

    // 5. Round numbers (weight: 10)
    const rounds = roundNumbers(currentPrice);
    for (const lvl of rounds) {
        const dist = Math.abs(lvl - currentPrice) / atr;
        if (dist < 5) {
            candidates.push({ price: lvl, source: "RN", weight: 10, recency: 0.5 });
        }
    }

    // ── Cluster candidates within 0.3 * ATR ──
    const clusterDist = atr * 0.3;
    const sorted = [...candidates].sort((a, b) => a.price - b.price);

    interface MergedZone {
        prices: number[];
        weights: number[];
        sources: Set<string>;
        recencies: number[];
    }

    const merged: MergedZone[] = [];
    for (const c of sorted) {
        const lastMerged = merged[merged.length - 1];
        const lastAvg = lastMerged
            ? lastMerged.prices.reduce((a, b) => a + b, 0) / lastMerged.prices.length
            : 0;

        if (lastMerged && Math.abs(c.price - lastAvg) <= clusterDist) {
            lastMerged.prices.push(c.price);
            lastMerged.weights.push(c.weight);
            lastMerged.sources.add(c.source);
            lastMerged.recencies.push(c.recency);
        } else {
            merged.push({
                prices: [c.price],
                weights: [c.weight],
                sources: new Set([c.source]),
                recencies: [c.recency],
            });
        }
    }

    // ── Score zones ──
    const zones: LiquidityZone[] = [];
    for (const m of merged) {
        const avgPrice = m.prices.reduce((a, b) => a + b, 0) / m.prices.length;
        const rawWeight = m.weights.reduce((a, b) => a + b, 0);
        const avgRecency = m.recencies.reduce((a, b) => a + b, 0) / m.recencies.length;

        let score = rawWeight;

        // Proximity bonus
        const distance = Math.abs(avgPrice - currentPrice) / atr;
        if (distance < 1) score *= 1.5;
        else if (distance < 2) score *= 1.3;

        // Multi-source confluence bonus
        if (m.sources.size >= 3) score *= 1.4;
        else if (m.sources.size >= 2) score *= 1.2;

        // Recency factor
        score *= avgRecency;

        score = Math.min(Math.round(score), 100);

        // Filter
        if (score < 20) continue;
        if (distance > 5) continue;

        const type = avgPrice < currentPrice ? "support" : "resistance";
        const estimatedLiquidity = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

        zones.push({
            price: Math.round(avgPrice * 100) / 100,
            width: atr * 0.2,
            strength: score,
            type,
            sources: Array.from(m.sources),
            estimatedLiquidity,
        });
    }

    // Sort by strength, return top 8
    zones.sort((a, b) => b.strength - a.strength);
    return { zones: zones.slice(0, 8), currentPrice };
}
