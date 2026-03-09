import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    IChartApi,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { RegimeSegment, RegimeType } from "./regimeDetector";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

const REGIME_COLORS: Record<RegimeType, string> = {
    TRENDING_UP:    "rgba(34, 197, 94, 0.06)",
    TRENDING_DOWN:  "rgba(239, 68, 68, 0.06)",
    RANGING:        "rgba(59, 130, 246, 0.06)",
    VOLATILE:       "rgba(249, 115, 22, 0.06)",
    TRANSITIONING:  "rgba(156, 163, 175, 0.04)",
};

/** Solid colors for the legend dot */
export const REGIME_SOLID_COLORS: Record<RegimeType, string> = {
    TRENDING_UP:    "rgb(34, 197, 94)",
    TRENDING_DOWN:  "rgb(239, 68, 68)",
    RANGING:        "rgb(59, 130, 246)",
    VOLATILE:       "rgb(249, 115, 22)",
    TRANSITIONING:  "rgb(156, 163, 175)",
};

class RegimeBandsPaneView implements IPrimitivePaneView {
    private _primitive: RegimeBandsPrimitive;

    constructor(primitive: RegimeBandsPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const segments = this._primitive.segments;
        const chart = this._primitive.chart;

        return {
            draw(target: RenderTarget) {
                if (!chart || segments.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    const timeScale = chart.timeScale();

                    for (const seg of segments) {
                        const x1 = timeScale.timeToCoordinate(seg.startTime as Time);
                        const x2 = timeScale.timeToCoordinate(seg.endTime as Time);

                        if (x1 == null || x2 == null) continue;

                        // Extend bands to cover full candle width
                        const bandX1 = Math.min(x1, x2);
                        const bandX2 = Math.max(x1, x2);
                        // Add padding to cover half a candle on each side
                        const padding = Math.max((bandX2 - bandX1) / (segments.length || 1) * 0.5, 4);

                        context.fillStyle = REGIME_COLORS[seg.regime];
                        context.fillRect(
                            bandX1 - padding,
                            0,
                            bandX2 - bandX1 + padding * 2,
                            mediaSize.height,
                        );
                    }
                });
            },
        };
    }
}

export class RegimeBandsPrimitive implements ISeriesPrimitive<Time> {
    private _segments: RegimeSegment[] = [];
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: RegimeBandsPaneView[];

    constructor() {
        this._paneViews = [new RegimeBandsPaneView(this)];
    }

    get segments(): RegimeSegment[] {
        return this._segments;
    }

    get chart(): IChartApi | null {
        return this._chart;
    }

    setSegments(segments: RegimeSegment[]): void {
        this._segments = segments;
        this._requestUpdate?.();
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this._chart = param.chart;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._chart = null;
        this._requestUpdate = null;
    }

    updateAllViews(): void {
        // pane views are updated via reference to segments
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
