/**
 * footprintPrimitive.ts — Renders buy/sell volume numbers inside candle bodies.
 *
 * Buy qty on LEFT (green), sell qty on RIGHT (red), per $10 price bucket.
 * Auto-hides when candle width < 40px or timeframe not in [1m, 5m, 15m].
 * Delta label below each candle.
 */

import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IPrimitivePaneView,
    IChartApi,
} from "lightweight-charts";
import type { FootprintCandle } from "./useFootprint";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

interface RawCandle {
    ts: string;
    high: string;
    low: string;
    close: string;
}

const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

function detectAbsorption(
    buckets: Record<string, { b: number; s: number }>,
    candleClose: number,
): Set<number> {
    const absorbed = new Set<number>();
    const RATIO = 3;
    const MIN_QTY = 0.01;

    for (const [priceStr, { b, s }] of Object.entries(buckets)) {
        const price = Number(priceStr);
        if (b < MIN_QTY && s < MIN_QTY) continue;

        // Bid absorption: buyers aggressive (b >= 3x s) but price rejected
        if (s >= MIN_QTY && b >= s * RATIO && candleClose <= price + 10) {
            absorbed.add(price);
        }

        // Ask absorption: sellers aggressive (s >= 3x b) but price held
        if (b >= MIN_QTY && s >= b * RATIO && candleClose >= price) {
            absorbed.add(price);
        }
    }

    return absorbed;
}

class FootprintPaneView implements IPrimitivePaneView {
    private _primitive: FootprintPrimitive;

    constructor(primitive: FootprintPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const primitive = this._primitive;

        return {
            draw(target: RenderTarget) {
                const data = primitive.footprintData;
                const series = primitive.series;
                const chart = primitive.chart;
                const rawCandles = primitive.rawCandles;
                const candleWidthPx = primitive.candleWidthPx;

                if (!series || !chart || !data || data.size === 0) return;
                if (candleWidthPx < 12) return;

                target.useMediaCoordinateSpace(({ context }) => {
                    context.save();

                    for (const [openTimeMs, fp] of data) {
                        // Find matching raw candle
                        const rc = rawCandles.find((c) => {
                            const cMs = new Date(c.ts).getTime();
                            return Math.abs(cMs - openTimeMs) < 60_000;
                        });
                        if (!rc) continue;

                        // Get X center via time coordinate
                        const candleTimeSec = (new Date(rc.ts).getTime() / 1000 + TZ_OFFSET_SEC) as unknown as Time;
                        const x = chart.timeScale().timeToCoordinate(candleTimeSec);
                        if (x === null) continue;

                        const high = parseFloat(rc.high);
                        const low = parseFloat(rc.low);
                        const yHigh = series.priceToCoordinate(high);
                        const yLow = series.priceToCoordinate(low);
                        if (yHigh === null || yLow === null) continue;

                        const candleHeightPx = Math.abs(yLow - yHigh);
                        if (candleHeightPx <= 0) continue;

                        // Get visible buckets within candle range
                        const visibleBuckets = Object.entries(fp.buckets)
                            .map(([price, d]) => ({ price: Number(price), ...d }))
                            .filter((b) => b.price >= low - 10 && b.price <= high + 10)
                            .sort((a, b2) => b2.price - a.price);

                        if (visibleBuckets.length === 0) continue;

                        // Absorption detection
                        const closePrice = rc ? parseFloat(rc.close) : high;
                        const absorbedLevels = detectAbsorption(fp.buckets, closePrice);

                        const rowHeight = candleHeightPx / visibleBuckets.length;

                        const fontSize = Math.max(6, Math.min(10, Math.floor(rowHeight - 2), Math.floor(candleWidthPx / 8)));
                        context.font = `${fontSize}px monospace`;

                        const bodyWidth = candleWidthPx * 0.88;
                        const bodyX = x - bodyWidth / 2;

                        for (const bucket of visibleBuckets) {
                            // Skip empty rows at tight zoom
                            if (candleWidthPx < 25 && bucket.b < 0.001 && bucket.s < 0.001) continue;

                            const y = series.priceToCoordinate(bucket.price + 5);
                            if (y === null) continue;

                            const total = bucket.b + bucket.s;
                            const buyRatio = total > 0 ? bucket.b / total : 0.5;

                            // Dark background for readability
                            context.fillStyle = "rgba(0, 0, 0, 0.55)";
                            context.fillRect(bodyX, y - rowHeight / 2, bodyWidth, rowHeight);

                            // Row background tint
                            if (buyRatio > 0.7) {
                                context.fillStyle = "rgba(38, 166, 154, 0.12)";
                            } else if (buyRatio < 0.3) {
                                context.fillStyle = "rgba(239, 83, 80, 0.12)";
                            } else {
                                context.fillStyle = "rgba(255, 255, 255, 0.03)";
                            }
                            context.fillRect(bodyX, y - rowHeight / 2, bodyWidth, rowHeight);

                            // Absorption highlight — bright yellow with gold borders
                            if (absorbedLevels.has(bucket.price)) {
                                context.fillStyle = "rgba(255, 214, 0, 0.35)";
                                context.fillRect(bodyX, y - rowHeight / 2, bodyWidth, rowHeight);
                                context.strokeStyle = "rgba(255, 214, 0, 0.8)";
                                context.lineWidth = 1;
                                context.beginPath();
                                context.moveTo(bodyX, y - rowHeight / 2);
                                context.lineTo(bodyX + bodyWidth, y - rowHeight / 2);
                                context.moveTo(bodyX, y + rowHeight / 2);
                                context.lineTo(bodyX + bodyWidth, y + rowHeight / 2);
                                context.stroke();
                            }

                            // Row separator
                            context.strokeStyle = "rgba(255,255,255,0.05)";
                            context.lineWidth = 0.5;
                            context.beginPath();
                            context.moveTo(bodyX, y - rowHeight / 2);
                            context.lineTo(bodyX + bodyWidth, y - rowHeight / 2);
                            context.stroke();

                            // Text only when rows are tall enough to read
                            if (rowHeight >= 7) {
                                context.font = `${fontSize}px monospace`;

                                // Buy qty — LEFT — green
                                context.fillStyle = "#26a69a";
                                context.textAlign = "left";
                                context.fillText(bucket.b.toFixed(2), bodyX + 2, y + fontSize / 3);

                                // Sell qty — RIGHT — red
                                context.fillStyle = "#ef5350";
                                context.textAlign = "right";
                                context.fillText(bucket.s.toFixed(2), bodyX + bodyWidth - 2, y + fontSize / 3);
                            }
                        }

                        // Delta label below candle
                        const deltaY = yLow + 12;
                        context.font = "bold 9px monospace";
                        context.textAlign = "center";
                        context.fillStyle = fp.delta >= 0 ? "#26a69a" : "#ef5350";
                        context.fillText(
                            (fp.delta >= 0 ? "+" : "") + fp.delta.toFixed(2),
                            x,
                            deltaY,
                        );
                    }

                    context.restore();
                });
            },
        };
    }
}

export class FootprintPrimitive implements ISeriesPrimitive<Time> {
    private _data: Map<number, FootprintCandle> = new Map();
    private _rawCandles: RawCandle[] = [];
    private _candleWidthPx = 0;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: FootprintPaneView[];

    constructor() {
        this._paneViews = [new FootprintPaneView(this)];
    }

    get footprintData(): Map<number, FootprintCandle> | null {
        return this._data.size > 0 ? this._data : null;
    }

    get series(): ISeriesApi<"Candlestick"> | null { return this._series; }
    get chart(): IChartApi | null { return this._chart; }
    get rawCandles(): RawCandle[] { return this._rawCandles; }
    get candleWidthPx(): number { return this._candleWidthPx; }

    update(data: Map<number, FootprintCandle>, rawCandles: RawCandle[], candleWidthPx: number): void {
        this._data = data;
        this._rawCandles = rawCandles;
        this._candleWidthPx = candleWidthPx;
        this._requestUpdate?.();
    }

    setCandleWidth(w: number): void {
        this._candleWidthPx = w;
    }

    clear(): void {
        this._data = new Map();
        this._rawCandles = [];
        this._requestUpdate?.();
    }

    setChart(chart: IChartApi): void {
        this._chart = chart;
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this._series = param.series as ISeriesApi<"Candlestick">;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._chart = null;
        this._requestUpdate = null;
    }

    updateAllViews(): void {}

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
