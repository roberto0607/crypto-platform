import type { Candle } from "@/api/endpoints/candles";

// Lightweight Charts treats timestamps as UTC — offset to local timezone
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

export interface CvdPoint {
    time: number; // epoch seconds (local-adjusted for Lightweight Charts)
    value: number;
}

export interface CvdDivergence {
    startTime: number;
    endTime: number;
    type: "bullish" | "bearish";
}

export type CvdDataSource = "REAL" | "PROXY" | "MIXED";

export interface CvdResult {
    values: CvdPoint[];
    divergences: CvdDivergence[];
    dataSource: CvdDataSource;
    realCount: number;
    totalCount: number;
}

/**
 * Compute Cumulative Volume Delta from candle data.
 *
 * Path A (real): uses buy_volume - sell_volume when side data exists.
 * Path B (proxy): wick-weighted price action estimate when side data is missing.
 */
export function computeCVD(candles: Candle[]): CvdResult {
    const values: CvdPoint[] = [];
    let cumulative = 0;
    let realCount = 0;

    for (const c of candles) {
        const buyVol = parseFloat(c.buy_volume ?? "0");
        const sellVol = parseFloat(c.sell_volume ?? "0");
        const hasRealData = buyVol > 0 || sellVol > 0;

        let delta: number;

        if (hasRealData) {
            // Path A — real buy/sell volume from exchange trades
            delta = buyVol - sellVol;
            realCount++;
        } else {
            // Path B — wick-weighted price action proxy
            const open = parseFloat(c.open);
            const high = parseFloat(c.high);
            const low = parseFloat(c.low);
            const close = parseFloat(c.close);
            const volume = parseFloat(c.volume);
            const candleRange = high - low;

            if (candleRange === 0 || volume === 0) {
                delta = 0;
            } else {
                const bodyTop = Math.max(open, close);
                const bodyBottom = Math.min(open, close);
                const upperWick = high - bodyTop;
                const lowerWick = bodyBottom - low;
                const bodyMove = close - open;

                const wickBias = (lowerWick - upperWick) / candleRange;
                const bodyBias = bodyMove / candleRange;
                const bias = wickBias * 0.4 + bodyBias * 0.6;
                delta = bias * volume;
            }
        }

        cumulative += delta;
        values.push({
            time: new Date(c.ts).getTime() / 1000 + TZ_OFFSET_SEC,
            value: cumulative,
        });
    }

    const totalCount = candles.length;
    const realRatio = totalCount > 0 ? realCount / totalCount : 0;
    const dataSource: CvdDataSource =
        realRatio > 0.8 ? "REAL" : realCount > 0 ? "MIXED" : "PROXY";

    const divergences = detectCvdDivergence(candles, values);

    return { values, divergences, dataSource, realCount, totalCount };
}

/**
 * Detect divergences between price and CVD.
 * - Bullish divergence: price makes a lower low but CVD makes a higher low
 * - Bearish divergence: price makes a higher high but CVD makes a lower high
 */
function detectCvdDivergence(
    candles: Candle[],
    cvd: CvdPoint[],
    lookback = 20,
): CvdDivergence[] {
    if (candles.length < lookback * 2 || cvd.length < lookback * 2) return [];

    const divergences: CvdDivergence[] = [];

    for (let i = lookback; i < candles.length - 5; i++) {
        const priceNow = parseFloat(candles[i]!.close);
        const cvdNow = cvd[i]?.value ?? 0;
        const timeNow = cvd[i]?.time ?? 0;

        for (let j = i - lookback; j < i - 5; j++) {
            if (j < 0) continue;
            const pricePrev = parseFloat(candles[j]!.close);
            const cvdPrev = cvd[j]?.value ?? 0;
            const timePrev = cvd[j]?.time ?? 0;

            // Bullish divergence: price lower low, CVD higher low
            if (priceNow < pricePrev && cvdNow > cvdPrev) {
                if (isLocalLow(candles, i, 3) && isLocalLow(candles, j, 3)) {
                    divergences.push({ startTime: timePrev, endTime: timeNow, type: "bullish" });
                }
            }

            // Bearish divergence: price higher high, CVD lower high
            if (priceNow > pricePrev && cvdNow < cvdPrev) {
                if (isLocalHigh(candles, i, 3) && isLocalHigh(candles, j, 3)) {
                    divergences.push({ startTime: timePrev, endTime: timeNow, type: "bearish" });
                }
            }
        }
    }

    // Deduplicate overlapping divergences
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
