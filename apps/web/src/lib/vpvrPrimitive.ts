/**
 * vpvrPrimitive.ts — Visible Range Volume Profile (VPVR)
 *
 * Renders horizontal volume bars on the right side of the main chart canvas.
 * Updates whenever the visible range changes (debounced at 50ms).
 * POC (Point of Control) highlighted in yellow with solid line.
 * Value Area (70% of total volume) shown with higher opacity.
 */

import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

export interface VPVRCandle {
    high: number;
    low: number;
    volume: number;
}

const NUM_BUCKETS = 60;
const VALUE_AREA_PCT = 0.70;

interface VPVRData {
    buckets: Float64Array;
    pocIndex: number;
    valueArea: Uint8Array; // 1 = in value area, 0 = outside
    vahIndex: number; // highest bucket in value area
    valIndex: number; // lowest bucket in value area
    min: number;
    max: number;
    bucketSize: number;
    maxVolume: number;
    weeklyMode: boolean;
}

class VPVRPaneView implements IPrimitivePaneView {
    private _primitive: VPVRPrimitive;

    constructor(primitive: VPVRPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const data = this._primitive.vpvrData;
        const series = this._primitive.series;

        return {
            draw(target: RenderTarget) {
                if (!series || !data || data.maxVolume === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    const chartWidth = mediaSize.width;
                    const maxBarWidth = chartWidth * 0.13;

                    const { buckets, pocIndex, valueArea, vahIndex, valIndex, min, bucketSize, maxVolume } = data;

                    // Draw volume bars
                    for (let i = 0; i < buckets.length; i++) {
                        const vol = buckets[i]!;
                        if (vol === 0) continue;

                        const priceCenter = min + (i + 0.5) * bucketSize;
                        const priceTop = min + (i + 1) * bucketSize;
                        const priceBottom = min + i * bucketSize;

                        const yCenter = series.priceToCoordinate(priceCenter);
                        const yTop = series.priceToCoordinate(priceTop);
                        const yBottom = series.priceToCoordinate(priceBottom);

                        if (yCenter === null) continue;

                        const barWidth = (vol / maxVolume) * maxBarWidth;
                        const barHeight = yTop !== null && yBottom !== null
                            ? Math.max(1, Math.abs(yBottom - yTop))
                            : Math.max(1, mediaSize.height / NUM_BUCKETS);

                        const x = chartWidth - barWidth;

                        if (i === pocIndex) {
                            context.fillStyle = "rgba(234, 179, 8, 0.5)";
                        } else if (valueArea[i]) {
                            context.fillStyle = "rgba(6, 182, 212, 0.20)";
                        } else {
                            context.fillStyle = "rgba(6, 182, 212, 0.08)";
                        }
                        context.fillRect(x, yCenter - barHeight / 2, barWidth, barHeight);
                    }

                    const wk = data.weeklyMode;
                    const prefix = wk ? "W-" : "";

                    // Draw POC line
                    const pocPrice = min + (pocIndex + 0.5) * bucketSize;
                    const pocY = series.priceToCoordinate(pocPrice);
                    if (pocY !== null) {
                        context.save();
                        context.strokeStyle = "#eab308";
                        context.lineWidth = 1.5;
                        if (!wk) context.setLineDash([]); // solid in both modes — POC is always solid
                        context.beginPath();
                        context.moveTo(0, pocY);
                        context.lineTo(chartWidth, pocY);
                        context.stroke();
                        context.setLineDash([]);

                        const label = `${prefix}POC`;
                        context.font = "bold 11px monospace";
                        const tw = context.measureText(label).width;
                        const lx = chartWidth - tw - 8;
                        const ly = pocY - 5;
                        context.fillStyle = "rgba(0,0,0,0.6)";
                        context.fillRect(lx - 3, ly - 10, tw + 6, 14);
                        context.fillStyle = "#eab308";
                        context.fillText(label, lx, ly);
                        context.restore();
                    }

                    // VAH and VAL prices
                    const vahPrice = min + (vahIndex + 1) * bucketSize;
                    const valPrice = min + valIndex * bucketSize;
                    const vahY = series.priceToCoordinate(vahPrice);
                    const valY = series.priceToCoordinate(valPrice);

                    // Shaded fill between VAH and VAL
                    if (vahY !== null && valY !== null) {
                        const top = Math.min(vahY, valY);
                        const h = Math.abs(valY - vahY);
                        context.fillStyle = "rgba(128, 128, 128, 0.06)";
                        context.fillRect(0, top, chartWidth, h);
                    }

                    // Helper to draw a labeled line (solid in weekly, dashed in visible)
                    const drawLevelLine = (y: number | null, price: number, label: string, color: string) => {
                        if (y === null) return;
                        context.save();
                        context.strokeStyle = color;
                        context.lineWidth = 1.5;
                        if (!wk) context.setLineDash([4, 4]);
                        context.beginPath();
                        context.moveTo(0, y);
                        context.lineTo(chartWidth, y);
                        context.stroke();
                        context.setLineDash([]);

                        const priceStr = price >= 1000 ? price.toFixed(0) : price.toFixed(2);
                        const text = `${prefix}${label} ${priceStr}`;
                        context.font = "bold 10px monospace";
                        const tw = context.measureText(text).width;
                        const lx = chartWidth - tw - 8;
                        const ly = y - 4;
                        context.fillStyle = "rgba(0,0,0,0.6)";
                        context.fillRect(lx - 3, ly - 9, tw + 6, 13);
                        context.fillStyle = color;
                        context.fillText(text, lx, ly);
                        context.restore();
                    };

                    drawLevelLine(vahY, vahPrice, "VAH", "#26a69a");
                    drawLevelLine(valY, valPrice, "VAL", "#ef5350");
                });
            },
        };
    }
}

export class VPVRPrimitive implements ISeriesPrimitive<Time> {
    private _data: VPVRData | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: VPVRPaneView[];

    constructor() {
        this._paneViews = [new VPVRPaneView(this)];
    }

    get vpvrData(): VPVRData | null {
        return this._data;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    update(candles: VPVRCandle[], weeklyMode = false): void {
        if (candles.length === 0) {
            this._data = null;
            this._requestUpdate?.();
            return;
        }

        let min = Infinity;
        let max = -Infinity;
        for (const c of candles) {
            if (c.low < min) min = c.low;
            if (c.high > max) max = c.high;
        }

        if (max <= min) {
            this._data = null;
            this._requestUpdate?.();
            return;
        }

        const bucketSize = (max - min) / NUM_BUCKETS;
        const buckets = new Float64Array(NUM_BUCKETS);

        for (const c of candles) {
            const lo = Math.max(0, Math.floor((c.low - min) / bucketSize));
            const hi = Math.min(NUM_BUCKETS - 1, Math.floor((c.high - min) / bucketSize));
            const span = hi - lo + 1;
            const volPerBucket = c.volume / span;
            for (let b = lo; b <= hi; b++) {
                buckets[b]! += volPerBucket;
            }
        }

        // Find POC and total volume
        let maxVolume = 0;
        let pocIndex = 0;
        let totalVolume = 0;
        for (let i = 0; i < NUM_BUCKETS; i++) {
            totalVolume += buckets[i]!;
            if (buckets[i]! > maxVolume) {
                maxVolume = buckets[i]!;
                pocIndex = i;
            }
        }

        // Compute Value Area (70% of total volume, expanding from POC)
        const valueArea = new Uint8Array(NUM_BUCKETS);
        const targetVolume = totalVolume * VALUE_AREA_PCT;
        let vaVolume = buckets[pocIndex]!;
        valueArea[pocIndex] = 1;
        let lo = pocIndex - 1;
        let hi = pocIndex + 1;

        while (vaVolume < targetVolume && (lo >= 0 || hi < NUM_BUCKETS)) {
            const loVol = lo >= 0 ? buckets[lo]! : 0;
            const hiVol = hi < NUM_BUCKETS ? buckets[hi]! : 0;

            if (loVol >= hiVol && lo >= 0) {
                vaVolume += loVol;
                valueArea[lo] = 1;
                lo--;
            } else if (hi < NUM_BUCKETS) {
                vaVolume += hiVol;
                valueArea[hi] = 1;
                hi++;
            } else if (lo >= 0) {
                vaVolume += loVol;
                valueArea[lo] = 1;
                lo--;
            } else {
                break;
            }
        }

        // VAH = highest bucket in value area, VAL = lowest
        let vahIndex = pocIndex;
        let valIndex = pocIndex;
        for (let i = 0; i < NUM_BUCKETS; i++) {
            if (valueArea[i]) {
                if (i > vahIndex) vahIndex = i;
                if (i < valIndex) valIndex = i;
            }
        }

        this._data = { buckets, pocIndex, valueArea, vahIndex, valIndex, min, max, bucketSize, maxVolume, weeklyMode };
        this._requestUpdate?.();
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this._series = param.series as ISeriesApi<"Candlestick">;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._requestUpdate = null;
        this._data = null;
    }

    updateAllViews(): void {
        // data updated via update()
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
