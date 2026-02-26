import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { D, toFixed8 } from "../utils/decimal";

export type Tick = {
    bid: string;
    ask: string;
    last: string;
    ts: number;
};

export type CandleInput = {
    open: string;
    high: string;
    low: string;
    close: string;
    ts: string; // ISO string or epoch
};

const DEFAULT_SPREAD_BPS = 5;

/**
 * Deterministic seed from candle identity.
 * SHA256(pairId + candle.ts + timeframe) → 32 bytes.
 */
function makeSeed(pairId: string, candleTs: string, timeframe: string): Buffer {
    return createHash("sha256")
        .update(pairId + candleTs + timeframe)
        .digest();
}

/**
 * Extract a deterministic float [0, 1) from seed bytes at a given offset.
 * Reads 4 bytes as uint32 and divides by 2^32.
 */
function seedFloat(seed: Buffer, offset: number): number {
    const idx = offset % (seed.length - 3);
    const val = seed.readUInt32BE(idx);
    return val / 0x100000000;
}

/**
 * Apply spread to a mid price.
 * bid = mid * (1 - spreadBps / 20000)
 * ask = mid * (1 + spreadBps / 20000)
 */
function applySpread(mid: Decimal, spreadBps: number): { bid: string; ask: string } {
    const halfSpread = D(spreadBps).div(D(20000));
    return {
        bid: toFixed8(mid.mul(D(1).minus(halfSpread))),
        ask: toFixed8(mid.mul(D(1).plus(halfSpread))),
    };
}

/**
 * Generate deterministic micro-ticks from a single OHLC candle.
 *
 * Path: open → (high or low first, determined by seed) → the other → close.
 * Intermediate ticks are linearly interpolated between waypoints.
 * Same inputs always produce identical output.
 */
export function generateMicroTicks(
    candle: CandleInput,
    pairId: string,
    timeframe: string,
    tickIntervalMs: number = 250,
    spreadBps: number = DEFAULT_SPREAD_BPS
): Tick[] {
    const seed = makeSeed(pairId, candle.ts, timeframe);

    const open = D(candle.open);
    const high = D(candle.high);
    const low = D(candle.low);
    const close = D(candle.close);

    // Determine candle duration from timeframe
    const durationMs = timeframeToDurationMs(timeframe);
    const totalTicks = Math.max(Math.floor(durationMs / tickIntervalMs), 4);
    const candleStartMs = new Date(candle.ts).getTime();

    // Decide visit order: high-first or low-first (deterministic from seed)
    const highFirst = seedFloat(seed, 0) < 0.5;

    // Waypoint positions within [0, totalTicks-1]
    // First waypoint (high or low) lands ~25-45% through candle
    // Second waypoint lands ~55-75% through candle
    const wp1Frac = 0.25 + seedFloat(seed, 4) * 0.2; // [0.25, 0.45)
    const wp2Frac = 0.55 + seedFloat(seed, 8) * 0.2; // [0.55, 0.75)

    const wp1Idx = Math.round(wp1Frac * (totalTicks - 1));
    const wp2Idx = Math.round(wp2Frac * (totalTicks - 1));

    // Build waypoints: [index, price]
    const waypoints: [number, Decimal][] = [
        [0, open],
        [wp1Idx, highFirst ? high : low],
        [wp2Idx, highFirst ? low : high],
        [totalTicks - 1, close],
    ];

    // Generate ticks by linear interpolation between waypoints
    const ticks: Tick[] = [];
    let wpCursor = 0;

    for (let i = 0; i < totalTicks; i++) {
        // Advance waypoint cursor
        while (wpCursor < waypoints.length - 2 && i >= waypoints[wpCursor + 1][0]) {
            wpCursor++;
        }

        const [startIdx, startPrice] = waypoints[wpCursor];
        const [endIdx, endPrice] = waypoints[wpCursor + 1];

        // Linear interpolation
        let price: Decimal;
        if (endIdx === startIdx) {
            price = startPrice;
        } else {
            const t = (i - startIdx) / (endIdx - startIdx);
            price = startPrice.plus(endPrice.minus(startPrice).mul(t));
        }

        // Clamp to [low, high]
        if (price.gt(high)) price = high;
        if (price.lt(low)) price = low;

        const lastStr = toFixed8(price);
        const { bid, ask } = applySpread(price, spreadBps);

        ticks.push({
            bid,
            ask,
            last: lastStr,
            ts: candleStartMs + i * tickIntervalMs,
        });
    }

    return ticks;
}

function timeframeToDurationMs(tf: string): number {
    switch (tf) {
        case "1m":  return 60_000;
        case "5m":  return 300_000;
        case "15m": return 900_000;
        case "1h":  return 3_600_000;
        case "4h":  return 14_400_000;
        case "1d":  return 86_400_000;
        default:    return 60_000;
    }
}
