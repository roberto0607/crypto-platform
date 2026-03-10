import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { FairValueGap } from "./fairValueGaps";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

class FvgPaneView implements IPrimitivePaneView {
    private _primitive: FvgPrimitive;

    constructor(primitive: FvgPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const gaps = this._primitive.gaps;
        const series = this._primitive.series;

        return {
            draw(target: RenderTarget) {
                if (!series || gaps.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    for (const gap of gaps) {
                        const yTop = series.priceToCoordinate(gap.top);
                        const yBottom = series.priceToCoordinate(gap.bottom);

                        if (yTop == null || yBottom == null) continue;

                        const top = Math.min(yTop, yBottom);
                        const height = Math.abs(yBottom - yTop);

                        const isBullish = gap.type === "bullish";
                        // Bullish FVG: teal, Bearish FVG: orange
                        const baseColor = isBullish ? "6, 182, 212" : "249, 115, 22";

                        // Zone fill
                        context.fillStyle = `rgba(${baseColor}, 0.06)`;
                        context.fillRect(0, top, mediaSize.width, height);

                        // Dashed border (top and bottom edges)
                        context.strokeStyle = `rgba(${baseColor}, 0.2)`;
                        context.lineWidth = 1;
                        context.setLineDash([4, 4]);
                        context.beginPath();
                        context.moveTo(0, top);
                        context.lineTo(mediaSize.width, top);
                        context.moveTo(0, top + height);
                        context.lineTo(mediaSize.width, top + height);
                        context.stroke();
                        context.setLineDash([]);

                        // Label on right edge
                        context.fillStyle = isBullish ? "#06b6d4" : "#f97316";
                        context.font = "10px monospace";
                        context.textAlign = "right";
                        context.fillText("FVG", mediaSize.width - 8, top + height / 2 + 3);
                        context.textAlign = "left";
                    }
                });
            },
        };
    }
}

export class FvgPrimitive implements ISeriesPrimitive<Time> {
    private _gaps: FairValueGap[] = [];
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: FvgPaneView[];

    constructor() {
        this._paneViews = [new FvgPaneView(this)];
    }

    get gaps(): FairValueGap[] {
        return this._gaps;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    setGaps(gaps: FairValueGap[]): void {
        this._gaps = gaps;
        this._requestUpdate?.();
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this._series = param.series as ISeriesApi<"Candlestick">;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._requestUpdate = null;
    }

    updateAllViews(): void {
        // gaps updated via reference
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
