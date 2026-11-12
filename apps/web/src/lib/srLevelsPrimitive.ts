/**
 * Draws support/resistance levels (lib/srDisplay drawables) on the price pane:
 * a zone band (min..max of the level's pivots), a line at the anchor from the
 * pivot to the break bar (or the right edge), and — full levels only — a
 * label pill at the right end. Full levels at full strength, the rest faded; HTF levels dashed.
 */
import type {
    IChartApi,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from "lightweight-charts";
import { srLabelled, type SRDrawable } from "./srDisplay";
import { nudgeClear } from "./chartStudies";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}
interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

const FADED_ALPHA = 0.3;
const LABEL_FONT = "600 10px 'Space Mono', monospace";
const LABEL_H = 14;

/** Index of the first time >= t, or times.length. */
export function firstAtOrAfter(times: readonly number[], t: number): number {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! < t) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function withAlpha(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

class SRPaneView implements IPrimitivePaneView {
    constructor(private readonly p: SRLevelsPrimitive) {}

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const { series, chart, drawables, times } = this.p;
        return {
            draw(target: RenderTarget) {
                if (!series || !chart || drawables.length === 0 || times.length === 0) return;
                const ts = chart.timeScale();
                /** x of the chart bar at/after t; -Infinity left of the data, null right of it. */
                const xAt = (t: number): number | null => {
                    const i = firstAtOrAfter(times, t);
                    if (i >= times.length) return null;
                    if (i === 0 && t < times[0]!) return -Infinity;
                    return ts.timeToCoordinate(times[i] as Time);
                };

                target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
                    const labels: Array<{ y: number; text: string; color: string; alpha: number; xRight: number }> = [];
                    // Faded first, so full levels paint over them.
                    const ordered = [...drawables].sort((a, b) => (a.emphasis === b.emphasis ? 0 : a.emphasis === "faded" ? -1 : 1));
                    for (const d of ordered) {
                        const y = series.priceToCoordinate(d.price);
                        const yTop = series.priceToCoordinate(d.top);
                        const yBot = series.priceToCoordinate(d.bottom);
                        if (y === null || yTop === null || yBot === null) continue;
                        const xs = xAt(d.fromTime);
                        if (xs === null) continue;
                        const xe = d.toTime === null ? mediaSize.width : xAt(d.toTime) ?? mediaSize.width;
                        const x1 = Math.max(0, xs);
                        const x2 = Math.min(mediaSize.width, xe);
                        if (x2 <= x1) continue;
                        const alpha = d.emphasis === "full" ? 1 : FADED_ALPHA;

                        const h = Math.abs(yBot - yTop);
                        if (h >= 1) {
                            ctx.fillStyle = withAlpha(d.color, 0.1 * alpha);
                            ctx.fillRect(x1, Math.min(yTop, yBot), x2 - x1, h);
                        }
                        ctx.save();
                        ctx.strokeStyle = withAlpha(d.color, 0.85 * alpha);
                        ctx.lineWidth = d.emphasis === "full" ? 1.5 : 1;
                        if (d.dashed) ctx.setLineDash([6, 4]);
                        ctx.beginPath();
                        ctx.moveTo(x1, Math.round(y) + 0.5);
                        ctx.lineTo(x2, Math.round(y) + 0.5);
                        ctx.stroke();
                        ctx.restore();

                        // Labels: full levels only, at the right edge. Faded/old levels are line + zone;
                        // broken ones carry a break marker instead.
                        if (srLabelled(d)) labels.push({ y, text: d.label, color: d.color, alpha, xRight: x2 - 6 });
                    }

                    // Top to bottom; a label that would overlap the one above moves up.
                    labels.sort((a, b) => a.y - b.y);
                    const boxes: Array<{ top: number; bottom: number }> = [];
                    ctx.font = LABEL_FONT;
                    ctx.textBaseline = "middle";
                    for (const l of labels) {
                        const y = nudgeClear(l.y, LABEL_H / 2, boxes, -1, 2);
                        boxes.push({ top: y - LABEL_H / 2, bottom: y + LABEL_H / 2 });
                        const w = ctx.measureText(l.text).width + 10;
                        const x = l.xRight - w;
                        ctx.fillStyle = `rgba(8, 12, 18, ${0.85 * l.alpha})`;
                        ctx.fillRect(x, y - LABEL_H / 2, w, LABEL_H);
                        ctx.strokeStyle = withAlpha(l.color, 0.6 * l.alpha);
                        ctx.lineWidth = 1;
                        ctx.strokeRect(x + 0.5, y - LABEL_H / 2 + 0.5, w - 1, LABEL_H - 1);
                        ctx.fillStyle = withAlpha(l.color, l.alpha);
                        ctx.fillText(l.text, x + 5, y + 0.5);
                    }
                });
            },
        };
    }
}

export class SRLevelsPrimitive implements ISeriesPrimitive<Time> {
    drawables: SRDrawable[] = [];
    /** The chart's bar times, ascending (to place levels whose time isn't a bar). */
    times: number[] = [];
    series: ISeriesApi<"Candlestick"> | null = null;
    chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private readonly _views = [new SRPaneView(this)];

    setData(drawables: SRDrawable[], times: number[]): void {
        this.drawables = drawables;
        this.times = times;
        this._requestUpdate?.();
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this.series = param.series as ISeriesApi<"Candlestick">;
        this.chart = param.chart as IChartApi;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this.series = null;
        this.chart = null;
        this._requestUpdate = null;
    }

    updateAllViews(): void {}

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }
}
