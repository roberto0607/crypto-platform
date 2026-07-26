import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IChartApi,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { DrawingPoint } from "@/stores/drawingStore";
import type { MediaScope, RenderTarget } from "./drawingPrimitiveShared";

export interface PendingPreviewState {
    mode: "line" | "rect";
    anchor: DrawingPoint;
    cursor: DrawingPoint;
    color: string;
}

/** Dashed ghost preview shown while a 2-point tool (Trendline/Rectangle) is
 * mid-placement — anchor already clicked, second point not yet committed.
 * One instance, always attached; toggles on/off via setPreview(null). Not
 * interactive (no hitTest) — it never outlives the placement gesture. */
class PendingPreviewPaneView implements IPrimitivePaneView {
    constructor(private _primitive: PendingDrawingPreviewPrimitive) {}

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const primitive = this._primitive;
        return {
            draw(target: RenderTarget) {
                const state = primitive.state;
                const series = primitive.series;
                const chart = primitive.chart;
                if (!state || !series || !chart) return;

                const timeScale = chart.timeScale();
                const x0 = timeScale.timeToCoordinate(state.anchor.time as never);
                const y0 = series.priceToCoordinate(state.anchor.price);
                const x1 = timeScale.timeToCoordinate(state.cursor.time as never);
                const y1 = series.priceToCoordinate(state.cursor.price);
                if (x0 == null || y0 == null || x1 == null || y1 == null) return;

                target.useMediaCoordinateSpace(({ context }: MediaScope) => {
                    context.save();
                    context.strokeStyle = state.color;
                    context.lineWidth = 1.5;
                    context.setLineDash([4, 4]);
                    if (state.mode === "line") {
                        context.beginPath();
                        context.moveTo(x0, y0);
                        context.lineTo(x1, y1);
                        context.stroke();
                    } else {
                        const left = Math.min(x0, x1);
                        const top = Math.min(y0, y1);
                        context.strokeRect(left, top, Math.abs(x1 - x0), Math.abs(y1 - y0));
                    }
                    context.restore();
                });
            },
        };
    }
}

export class PendingDrawingPreviewPrimitive implements ISeriesPrimitive<Time> {
    private _state: PendingPreviewState | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews = [new PendingPreviewPaneView(this)];

    get state(): PendingPreviewState | null {
        return this._state;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    get chart(): IChartApi | null {
        return this._chart;
    }

    setChart(chart: IChartApi): void {
        this._chart = chart;
    }

    setPreview(state: PendingPreviewState | null): void {
        this._state = state;
        this._requestUpdate?.();
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
