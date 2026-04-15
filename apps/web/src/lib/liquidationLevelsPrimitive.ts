/**
 * liquidationLevelsPrimitive.ts — estimated liquidation clusters on-chart.
 *
 * Renders two layers, RIGHT of the current candle only:
 *  1. Heatmap bands — horizontal translucent fills at each cluster's price,
 *     $10 tall, extending from current candle X to right canvas edge.
 *     Long: red (rgba(255,50,50, intensity * 0.4))
 *     Short: green (rgba(50,255,100, intensity * 0.4))
 *     ALL raw clusters render as bands — no filtering.
 *  2. Labeled lines — only the top 3 MERGED clusters per side, with a
 *     40px minimum y-spacing. Labels: "$1.7B LONGS ↓" / "$1.7B SHORTS ↑"
 *     on a dark translucent rect. "EST." is implicit via the indicator
 *     label in the toolbar (so labels stay short/scannable).
 *
 * Data is mathematical estimation.
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
const MERGE_THRESHOLD_USD = 200; // clusters within $200 collapse into one labeled line
const TOP_LABELS_PER_SIDE = 3;
const MIN_LABEL_SPACING_PX = 40;
const MIN_LABELED_USD = 50_000_000; // hard floor — don't label clusters below $50M

function formatUsdShort(usd: number): string {
    if (usd >= 1e9) return "$" + (usd / 1e9).toFixed(1) + "B";
    if (usd >= 1e6) return "$" + Math.round(usd / 1e6) + "M";
    if (usd >= 1e3) return "$" + Math.round(usd / 1e3) + "K";
    return "$" + Math.round(usd);
}

/** Merge clusters of the same side whose prices are within MERGE_THRESHOLD_USD.
 *  Merge rule: weighted average price by estimatedUSD, summed USD, max intensity.
 *  Input does not need to be sorted; output is sorted by price ascending. */
function mergeClustersOneSide(list: LiquidationCluster[]): LiquidationCluster[] {
    if (list.length === 0) return [];
    const sorted = [...list].sort((a, b) => a.price - b.price);
    const merged: LiquidationCluster[] = [];
    for (const c of sorted) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(c.price - last.price) < MERGE_THRESHOLD_USD) {
            const combinedUsd = last.estimatedUSD + c.estimatedUSD;
            // Weighted average price (by USD share)
            last.price = combinedUsd > 0
                ? (last.price * last.estimatedUSD + c.price * c.estimatedUSD) / combinedUsd
                : (last.price + c.price) / 2;
            last.estimatedUSD = combinedUsd;
            last.intensity = Math.max(last.intensity, c.intensity);
            // leverage becomes ambiguous post-merge; keep the dominant one
            if (c.estimatedUSD > last.estimatedUSD / 2) last.leverage = c.leverage;
        } else {
            merged.push({ ...c });
        }
    }
    return merged;
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

                    // LAYER 1 — heatmap bands (all raw clusters, no filtering)
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

                    // LAYER 2 — merged + top-3 + 40px-spaced labeled lines
                    const longs = clusters.filter((c) => c.side === "long");
                    const shorts = clusters.filter((c) => c.side === "short");

                    // Merge adjacent clusters per side
                    const mergedLongs = mergeClustersOneSide(longs);
                    const mergedShorts = mergeClustersOneSide(shorts);

                    // $50M floor + top-3 by USD per side. If fewer than 3 pass
                    // the floor, only draw however many qualify.
                    const topLongs = mergedLongs
                        .filter((c) => c.estimatedUSD >= MIN_LABELED_USD)
                        .sort((a, b) => b.estimatedUSD - a.estimatedUSD)
                        .slice(0, TOP_LABELS_PER_SIDE);
                    const topShorts = mergedShorts
                        .filter((c) => c.estimatedUSD >= MIN_LABELED_USD)
                        .sort((a, b) => b.estimatedUSD - a.estimatedUSD)
                        .slice(0, TOP_LABELS_PER_SIDE);

                    // Resolve y-coords; drop any cluster that doesn't map into the pane
                    interface Placed {
                        c: LiquidationCluster;
                        y: number;
                    }
                    const placeAll = (cs: LiquidationCluster[]): Placed[] => {
                        const out: Placed[] = [];
                        for (const c of cs) {
                            const y = series.priceToCoordinate(c.price);
                            if (y !== null) out.push({ c, y: y as number });
                        }
                        return out;
                    };

                    // Enforce MIN_LABEL_SPACING_PX within each side, keeping larger
                    // USD clusters when a collision occurs.
                    const enforceSpacing = (placed: Placed[]): Placed[] => {
                        // Sort by USD desc so larger wins on collision
                        const byUsdDesc = [...placed].sort((a, b) => b.c.estimatedUSD - a.c.estimatedUSD);
                        const kept: Placed[] = [];
                        for (const p of byUsdDesc) {
                            const collides = kept.some((k) => Math.abs(k.y - p.y) < MIN_LABEL_SPACING_PX);
                            if (!collides) kept.push(p);
                        }
                        return kept;
                    };

                    const longsToDraw = enforceSpacing(placeAll(topLongs));
                    const shortsToDraw = enforceSpacing(placeAll(topShorts));

                    context.font = "bold 11px 'Space Mono', monospace";
                    context.textBaseline = "middle";

                    const drawLabeledLine = (p: Placed) => {
                        const { c, y } = p;
                        const stroke = c.side === "long" ? "#ff3232" : "#32ff64";
                        context.strokeStyle = stroke;
                        context.lineWidth = 1;
                        context.setLineDash([4, 4]);
                        context.beginPath();
                        context.moveTo(x, y);
                        context.lineTo(rightEdge, y);
                        context.stroke();
                        context.setLineDash([]);

                        const arrow = c.side === "long" ? "↓" : "↑";
                        const sideWord = c.side === "long" ? "LONGS" : "SHORTS";
                        const label = `${formatUsdShort(c.estimatedUSD)} ${sideWord} ${arrow}`;
                        const textW = context.measureText(label).width;
                        const padX = 6;
                        const boxW = textW + padX * 2;
                        const boxH = 16;
                        const boxX = rightEdge - boxW - 4;
                        const boxY = y - boxH / 2;

                        context.fillStyle = "rgba(0, 0, 0, 0.75)";
                        context.fillRect(boxX, boxY, boxW, boxH);
                        context.fillStyle = stroke;
                        context.textAlign = "left";
                        context.fillText(label, boxX + padX, y);
                    };

                    for (const p of longsToDraw) drawLabeledLine(p);
                    for (const p of shortsToDraw) drawLabeledLine(p);

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
