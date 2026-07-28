import type { DrawingPoint } from "@/stores/drawingStore";
import type { Timeframe } from "@/api/endpoints/candles";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "1w": 604800,
};

export interface MeasureStats {
    priceDelta: number;
    pctDelta: number;
    timeDeltaSec: number;
    candleCount: number;
}

/** Pure derivation of the Measure tool's live readout — start/end are raw
 * (time, price) points, never persisted (the tool itself never commits a
 * drawing; see the Gate 1 addendum on Measure being transient). */
export function computeMeasureStats(
    start: DrawingPoint,
    end: DrawingPoint,
    timeframeSeconds: number,
): MeasureStats {
    const priceDelta = end.price - start.price;
    const pctDelta = start.price !== 0 ? (priceDelta / start.price) * 100 : 0;
    const timeDeltaSec = Math.abs(end.time - start.time);
    const candleCount = timeframeSeconds > 0 ? Math.round(timeDeltaSec / timeframeSeconds) : 0;
    return { priceDelta, pctDelta, timeDeltaSec, candleCount };
}

/** Human-readable elapsed duration, e.g. "3h 20m", "45m", "2d 5h". */
export function formatDuration(totalSeconds: number): string {
    const s = Math.abs(Math.round(totalSeconds));
    if (s < 60) return "< 1m";
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
}
