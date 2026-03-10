import type { Candle } from "@/api/endpoints/candles";

export interface CvdPoint {
    time: number; // epoch seconds
    value: number;
}

export interface CvdDivergence {
    startTime: number;
    endTime: number;
    type: "bullish" | "bearish";
}

/**
 * Compute Cumulative Volume Delta from candle data.
 * CVD[i] = CVD[i-1] + (buyVolume[i] - sellVolume[i])
 */
export function computeCVD(candles: Candle[]): CvdPoint[] {
    const points: CvdPoint[] = [];
    let cumulative = 0;

    for (const c of candles) {
        const buyVol = parseFloat(c.buy_volume ?? "0");
        const sellVol = parseFloat(c.sell_volume ?? "0");
        cumulative += buyVol - sellVol;

        points.push({
            time: new Date(c.ts).getTime() / 1000,
            value: cumulative,
        });
    }

    return points;
}

/**
 * Detect divergences between price and CVD.
 * - Bullish divergence: price makes a lower low but CVD makes a higher low
 * - Bearish divergence: price makes a higher high but CVD makes a lower high
 *
 * Uses swing-point comparison over a lookback window.
 */
export function detectCvdDivergence(
    candles: Candle[],
    cvd: CvdPoint[],
    lookback = 20,
): CvdDivergence[] {
    if (candles.length < lookback * 2 || cvd.length < lookback * 2) return [];

    const divergences: CvdDivergence[] = [];

    // Find swing lows and highs in both price and CVD
    for (let i = lookback; i < candles.length - 5; i++) {
        const priceNow = parseFloat(candles[i]!.close);
        const cvdNow = cvd[i]?.value ?? 0;
        const timeNow = cvd[i]?.time ?? 0;

        // Look back for a previous comparable point
        for (let j = i - lookback; j < i - 5; j++) {
            if (j < 0) continue;
            const pricePrev = parseFloat(candles[j]!.close);
            const cvdPrev = cvd[j]?.value ?? 0;
            const timePrev = cvd[j]?.time ?? 0;

            // Bullish divergence: price lower low, CVD higher low
            if (priceNow < pricePrev && cvdNow > cvdPrev) {
                // Verify these are actual lows (price below neighbors)
                const isLowNow = isLocalLow(candles, i, 3);
                const isLowPrev = isLocalLow(candles, j, 3);
                if (isLowNow && isLowPrev) {
                    divergences.push({
                        startTime: timePrev,
                        endTime: timeNow,
                        type: "bullish",
                    });
                }
            }

            // Bearish divergence: price higher high, CVD lower high
            if (priceNow > pricePrev && cvdNow < cvdPrev) {
                const isHighNow = isLocalHigh(candles, i, 3);
                const isHighPrev = isLocalHigh(candles, j, 3);
                if (isHighNow && isHighPrev) {
                    divergences.push({
                        startTime: timePrev,
                        endTime: timeNow,
                        type: "bearish",
                    });
                }
            }
        }
    }

    // Deduplicate overlapping divergences — keep the most recent
    const deduped: CvdDivergence[] = [];
    for (const d of divergences) {
        const overlaps = deduped.some(
            (existing) =>
                existing.type === d.type &&
                Math.abs(existing.endTime - d.endTime) < 300,
        );
        if (!overlaps) deduped.push(d);
    }

    return deduped;
}

function isLocalLow(candles: Candle[], idx: number, range: number): boolean {
    const price = parseFloat(candles[idx]!.low);
    for (let j = idx - range; j <= idx + range; j++) {
        if (j === idx || j < 0 || j >= candles.length) continue;
        if (parseFloat(candles[j]!.low) < price) return false;
    }
    return true;
}

function isLocalHigh(candles: Candle[], idx: number, range: number): boolean {
    const price = parseFloat(candles[idx]!.high);
    for (let j = idx - range; j <= idx + range; j++) {
        if (j === idx || j < 0 || j >= candles.length) continue;
        if (parseFloat(candles[j]!.high) > price) return false;
    }
    return true;
}
