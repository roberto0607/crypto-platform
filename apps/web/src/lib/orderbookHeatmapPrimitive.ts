/**
 * orderbookHeatmapPrimitive.ts — Live order book heatmap overlay
 *
 * Renders bid/ask walls as colored bars on the LEFT side of the chart canvas.
 * VPVR renders on the RIGHT side — zero overlap guaranteed.
 *
 * Green (bids) and red (asks) bars extend from the left edge rightward.
 * Intensity = quantity relative to max visible quantity.
 * Whale walls (>70% of max) get a bright 1px horizontal line.
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

export interface HeatmapLevel {
    price: number;
    quantity: number;
}

interface HeatmapData {
    bids: HeatmapLevel[];
    asks: HeatmapLevel[];
    maxQuantity: number;
}

const MAX_BAR_WIDTH_PCT = 0.12;
const WHALE_THRESHOLD = 0.7;

class HeatmapPaneView implements IPrimitivePaneView {
    private _primitive: OrderbookHeatmapPrimitive;

    constructor(primitive: OrderbookHeatmapPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const primitive = this._primitive;

        return {
            draw(target: RenderTarget) {
                const data = primitive.heatmapData;
                const series = primitive.series;
                if (!series || !data || data.maxQuantity === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    const chartWidth = mediaSize.width;
                    const maxBarWidth = chartWidth * MAX_BAR_WIDTH_PCT;
                    const { bids, asks, maxQuantity } = data;

                    const normalize = (qty: number, maxQty: number) =>
                        maxQty <= 0 ? 0 : Math.log1p(qty) / Math.log1p(maxQty);
                    const minBarWidth = 4;

                    const drawLevel = (level: HeatmapLevel, nextPrice: number | null, color: string, lineColor: string) => {
                        const y = series.priceToCoordinate(level.price);
                        if (y === null) return;

                        const ratio = normalize(level.quantity, maxQuantity);
                        const barWidth = Math.max(minBarWidth, ratio * maxBarWidth);
                        const opacity = 0.2 + ratio * 0.6;

                        // Bar height: from this level's price to next level's price
                        let barHeight = 4; // fallback
                        if (nextPrice !== null) {
                            const yNext = series.priceToCoordinate(nextPrice);
                            if (yNext !== null) barHeight = Math.max(2, Math.abs(yNext - y));
                        }

                        // Draw from LEFT edge rightward
                        context.fillStyle = color.replace(")", `, ${opacity})`).replace("rgb", "rgba");
                        context.fillRect(0, y - barHeight / 2, barWidth, barHeight);

                        // Whale wall indicator
                        if (ratio > WHALE_THRESHOLD) {
                            context.strokeStyle = lineColor;
                            context.lineWidth = 1;
                            context.beginPath();
                            context.moveTo(0, y);
                            context.lineTo(barWidth + 20, y);
                            context.stroke();
                        }
                    };

                    // Draw bids (green, sorted high→low)
                    for (let i = 0; i < bids.length; i++) {
                        const nextPrice = i + 1 < bids.length ? bids[i + 1]!.price : null;
                        drawLevel(bids[i]!, nextPrice, "rgb(38, 166, 154", "#26a69a");
                    }

                    // Draw asks (red, sorted low→high)
                    for (let i = 0; i < asks.length; i++) {
                        const nextPrice = i + 1 < asks.length ? asks[i + 1]!.price : null;
                        drawLevel(asks[i]!, nextPrice, "rgb(239, 83, 80", "#ef5350");
                    }
                });
            },
        };
    }
}

export class OrderbookHeatmapPrimitive implements ISeriesPrimitive<Time> {
    private _data: HeatmapData | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: HeatmapPaneView[];

    constructor() {
        this._paneViews = [new HeatmapPaneView(this)];
    }

    get heatmapData(): HeatmapData | null {
        return this._data;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    update(bids: HeatmapLevel[], asks: HeatmapLevel[]): void {
        if (bids.length === 0 && asks.length === 0) {
            this._data = null;
            this._requestUpdate?.();
            return;
        }

        let maxQuantity = 0;
        for (const b of bids) if (b.quantity > maxQuantity) maxQuantity = b.quantity;
        for (const a of asks) if (a.quantity > maxQuantity) maxQuantity = a.quantity;

        this._data = { bids, asks, maxQuantity };
        this._requestUpdate?.();
    }

    clear(): void {
        this._data = null;
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
