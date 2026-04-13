/**
 * liquidationLevelsPrimitive.ts — estimated liquidation clusters on-chart.
 *
 * Renders two layers, RIGHT of the current candle only:
 *  1. Heatmap bands — horizontal translucent fills at each cluster's price,
 *     $10 tall, extending from current candle X to right canvas edge.
 *     Long: red (rgba(255,50,50, intensity * 0.4))
 *     Short: green (rgba(50,255,100, intensity * 0.4))
 *  2. Major cluster lines — dashed lines + right-side label for clusters
 *     > $50M. Long: red "~$XXM LONGS EST." / Short: green "~$XXM SHORTS EST."
 *
 * Data is mathematical estimation — a persistent "EST." badge lives inside
 * the labels so the indicator never looks like real exchange data.
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

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

export interface LiquidationCluster {
    price: number;
    side: "long" | "short";
    estimatedUSD: number;
    leverage: number;
    intensity: number;
}

const BUCKET_HEIGHT_USD = 10; // price band height in $; matches backend bucket
const MAJOR_CLUSTER_USD = 50_000_000;

function formatMillions(usd: number): string {
    if (usd >= 1e9) return (usd / 1e9).toFixed(1) + "B";
    return Math.round(usd / 1e6) + "M";
}

class LiquidationPaneView implements IPrimitivePaneView {
    private _primitive: LiquidationLevelsPrimitive;

    constructor(primitive: LiquidationLevelsPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const primitive = this._primitive;

        return {
            draw(target: RenderTarget) {
                const series = primitive.series;
                const chart = primitive.chart;
                const clusters = primitive.clusters;
                const latestTime = primitive.latestCandleTime;

                if (!series || !chart || clusters.length === 0 || latestTime === null) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    const x = chart.timeScale().timeToCoordinate(latestTime);
                    if (x === null) return;

                    const rightEdge = mediaSize.width;
                    if (x >= rightEdge) return;

                    context.save();

                    // LAYER 1 — heatmap bands
                    for (const c of clusters) {
                        const yTop = series.priceToCoordinate(c.price + BUCKET_HEIGHT_USD);
                        const yBot = series.priceToCoordinate(c.price);
                        if (yTop === null || yBot === null) continue;

                        const alpha = Math.max(0.05, Math.min(0.4, c.intensity * 0.4));
                        context.fillStyle = c.side === "long"
                            ? `rgba(255, 50, 50, ${alpha})`
                            : `rgba(50, 255, 100, ${alpha})`;
                        context.fillRect(x, yTop, rightEdge - x, yBot - yTop);
                    }

                    // LAYER 2 — major cluster lines + labels
                    context.font = "bold 10px 'Space Mono', monospace";
                    context.textBaseline = "middle";
                    for (const c of clusters) {
                        if (c.estimatedUSD < MAJOR_CLUSTER_USD) continue;
                        const y = series.priceToCoordinate(c.price);
                        if (y === null) continue;

                        const stroke = c.side === "long" ? "#ff3232" : "#32ff64";
                        context.strokeStyle = stroke;
                        context.lineWidth = 1;
                        context.setLineDash([4, 4]);
                        context.beginPath();
                        context.moveTo(x, y);
                        context.lineTo(rightEdge, y);
                        context.stroke();
                        context.setLineDash([]);

                        const label = `~$${formatMillions(c.estimatedUSD)} ${c.side === "long" ? "LONGS" : "SHORTS"} EST.`;
                        const textW = context.measureText(label).width;
                        const padX = 6;
                        const boxW = textW + padX * 2;
                        const boxH = 14;
                        const boxX = rightEdge - boxW - 4;
                        const boxY = y - boxH / 2;

                        context.fillStyle = "rgba(0, 0, 0, 0.75)";
                        context.fillRect(boxX, boxY, boxW, boxH);
                        context.fillStyle = stroke;
                        context.textAlign = "left";
                        context.fillText(label, boxX + padX, y);
                    }

                    context.restore();
                });
            },
        };
    }
}

export class LiquidationLevelsPrimitive implements ISeriesPrimitive<Time> {
    private _clusters: LiquidationCluster[] = [];
    private _latestCandleTime: Time | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: LiquidationPaneView[];

    constructor() {
        this._paneViews = [new LiquidationPaneView(this)];
    }

    get clusters(): LiquidationCluster[] { return this._clusters; }
    get latestCandleTime(): Time | null { return this._latestCandleTime; }
    get series(): ISeriesApi<"Candlestick"> | null { return this._series; }
    get chart(): IChartApi | null { return this._chart; }

    update(clusters: LiquidationCluster[], latestCandleTime: Time | null): void {
        this._clusters = clusters;
        this._latestCandleTime = latestCandleTime;
        this._requestUpdate?.();
    }

    clear(): void {
        this._clusters = [];
        this._latestCandleTime = null;
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
