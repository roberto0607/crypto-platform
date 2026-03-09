export type RegimeType = "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE" | "TRANSITIONING";

export interface RegimeSegment {
    startTime: number; // epoch seconds
    endTime: number;   // epoch seconds
    regime: RegimeType;
}

interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

function computeEMA(values: number[], period: number): number[] {
    const result: number[] = new Array(values.length).fill(NaN);
    if (values.length < period) return result;

    // SMA seed
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i]!;
    result[period - 1] = sum / period;

    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
        result[i] = values[i]! * k + result[i - 1]! * (1 - k);
    }
    return result;
}

function computeATR(candles: Candle[], period: number): number[] {
    const result: number[] = new Array(candles.length).fill(NaN);
    if (candles.length < 2) return result;

    const trs: number[] = [candles[0]!.high - candles[0]!.low];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i]!;
        const prevClose = candles[i - 1]!.close;
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    }

    // SMA seed for ATR
    if (trs.length < period) return result;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trs[i]!;
    result[period - 1] = sum / period;

    for (let i = period; i < trs.length; i++) {
        result[i] = (result[i - 1]! * (period - 1) + trs[i]!) / period;
    }
    return result;
}

const MIN_SEGMENT_LENGTH = 5;
const EMA_PERIOD = 20;
const ATR_PERIOD = 14;
const SLOPE_LOOKBACK = 10;
const VOLATILITY_THRESHOLD = 2.0; // ATR% > 2x rolling avg = volatile

/**
 * Detect market regimes from candle data using EMA slope, ATR, and price-EMA distance.
 * Returns merged segments with a minimum length of 5 candles.
 */
export function detectRegimes(candles: Candle[]): RegimeSegment[] {
    if (candles.length < Math.max(EMA_PERIOD, ATR_PERIOD) + SLOPE_LOOKBACK) return [];

    const closes = candles.map((c) => c.close);
    const ema20 = computeEMA(closes, EMA_PERIOD);
    const atr14 = computeATR(candles, ATR_PERIOD);

    // Compute rolling 50-period average of ATR% for volatility baseline
    const atrPct: number[] = candles.map((c, i) => {
        const a = atr14[i];
        return a != null && !isNaN(a) && c.close > 0 ? a / c.close : 0;
    });
    const rollingAtrAvg: number[] = new Array(candles.length).fill(0);
    const ROLLING_WINDOW = 50;
    let rollingSum = 0;
    let rollingCount = 0;
    for (let i = 0; i < candles.length; i++) {
        if (atrPct[i]! > 0) {
            rollingSum += atrPct[i]!;
            rollingCount++;
        }
        if (i >= ROLLING_WINDOW) {
            const old = atrPct[i - ROLLING_WINDOW]!;
            if (old > 0) {
                rollingSum -= old;
                rollingCount--;
            }
        }
        rollingAtrAvg[i] = rollingCount > 0 ? rollingSum / rollingCount : 0;
    }

    // Classify each candle
    const rawRegimes: RegimeType[] = [];
    for (let i = 0; i < candles.length; i++) {
        const e = ema20[i];
        const a = atr14[i];
        if (e == null || isNaN(e) || a == null || isNaN(a) || i < SLOPE_LOOKBACK) {
            rawRegimes.push("TRANSITIONING");
            continue;
        }

        // EMA slope: normalized by price
        const prevEma = ema20[i - SLOPE_LOOKBACK];
        const slope = prevEma != null && !isNaN(prevEma) && prevEma > 0
            ? (e - prevEma) / prevEma
            : 0;

        const close = candles[i]!.close;
        const distFromEma = Math.abs(close - e);
        const currentAtrPct = atrPct[i]!;
        const avgAtrPct = rollingAtrAvg[i]!;

        // Thresholds
        const slopeThreshold = 0.005; // 0.5% over lookback

        // 1. Volatility check first
        if (avgAtrPct > 0 && currentAtrPct > VOLATILITY_THRESHOLD * avgAtrPct) {
            rawRegimes.push("VOLATILE");
            continue;
        }

        // 2. Trend check
        if (slope > slopeThreshold) {
            rawRegimes.push("TRENDING_UP");
            continue;
        }
        if (slope < -slopeThreshold) {
            rawRegimes.push("TRENDING_DOWN");
            continue;
        }

        // 3. Range check: slope near zero AND price within 1 ATR of EMA
        if (distFromEma < a) {
            rawRegimes.push("RANGING");
            continue;
        }

        rawRegimes.push("TRANSITIONING");
    }

    // Build raw segments
    const rawSegments: RegimeSegment[] = [];
    let segStart = 0;
    for (let i = 1; i <= rawRegimes.length; i++) {
        if (i === rawRegimes.length || rawRegimes[i] !== rawRegimes[segStart]) {
            rawSegments.push({
                startTime: candles[segStart]!.time,
                endTime: candles[i - 1]!.time,
                regime: rawRegimes[segStart]!,
            });
            segStart = i;
        }
    }

    // Merge short segments into adjacent longer ones
    if (rawSegments.length === 0) return [];

    const merged: RegimeSegment[] = [rawSegments[0]!];
    for (let i = 1; i < rawSegments.length; i++) {
        const seg = rawSegments[i]!;
        const prev = merged[merged.length - 1]!;

        // Calculate segment length in candle count (approximate)
        const segLength = candles.filter(
            (c) => c.time >= seg.startTime && c.time <= seg.endTime,
        ).length;

        if (segLength < MIN_SEGMENT_LENGTH) {
            // Merge into previous segment
            prev.endTime = seg.endTime;
        } else {
            merged.push({ ...seg });
        }
    }

    return merged;
}
