/**
 * vpvrPrimitive.ts — Visible Range Volume Profile (VPVR)
 *
 * Renders horizontal volume bars on the right side of the main chart canvas.
 * Updates whenever the visible range changes (debounced at 50ms).
 * POC (Point of Control) is highlighted in yellow with a dashed horizontal line.
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

const NUM_BUCKETS = 100;

interface VPVRData {
    buckets: Float64Array;
    pocIndex: number;
    min: number;
    max: number;
    bucketSize: number;
    maxVolume: number;
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
                    const maxBarWidth = chartWidth * 0.20;

                    const { buckets, pocIndex, min, bucketSize, maxVolume } = data;

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

                        context.fillStyle = i === pocIndex
                            ? "rgba(234, 179, 8, 0.5)"
                            : "rgba(6, 182, 212, 0.25)";
                        context.fillRect(x, yCenter - barHeight / 2, barWidth, barHeight);
                    }

                    // Draw POC line
                    const pocPrice = min + (pocIndex + 0.5) * bucketSize;
                    const pocY = series.priceToCoordinate(pocPrice);
                    if (pocY !== null) {
                        context.save();
                        context.strokeStyle = "#eab308";
                        context.lineWidth = 1;
                        context.setLineDash([4, 4]);
                        context.beginPath();
                        context.moveTo(0, pocY);
                        context.lineTo(chartWidth, pocY);
                        context.stroke();
                        context.setLineDash([]);

                        // POC label
                        context.fillStyle = "#eab308";
                        context.font = "9px monospace";
                        context.fillText("POC", chartWidth - 28, pocY - 3);
                        context.restore();
                    }
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

    update(candles: VPVRCandle[]): void {
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

        let maxVolume = 0;
        let pocIndex = 0;
        for (let i = 0; i < NUM_BUCKETS; i++) {
            if (buckets[i]! > maxVolume) {
                maxVolume = buckets[i]!;
                pocIndex = i;
            }
        }

        this._data = { buckets, pocIndex, min, max, bucketSize, maxVolume };
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
