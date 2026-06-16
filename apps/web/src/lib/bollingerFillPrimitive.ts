import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IChartApi,
    IPrimitivePaneView,
} from "lightweight-charts";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

export interface BollingerFillPoint {
    time: number;
    upper: number;
    lower: number;
}

class BollingerFillPaneView implements IPrimitivePaneView {
    private _primitive: BollingerFillPrimitive;

    constructor(primitive: BollingerFillPrimitive) {
        this._primitive = primitive;
    }

    // Behind the candles AND the band lines — the fill is a faint backdrop,
    // never an occluder (alpha is ~0.07 so candles read clearly through it).
    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const data = this._primitive.data;
        const series = this._primitive.series;
        const chart = this._primitive.chart;
        const fill = this._primitive.fillColor;

        return {
            draw(target: RenderTarget) {
                if (!series || !chart || data.length < 2) return;

                const timeScale = chart.timeScale();

                target.useMediaCoordinateSpace(({ context }: MediaScope) => {
                    // Build one polygon: walk the upper band left→right, then the
                    // lower band right→left, and close. upper/lower are index-
                    // aligned (same loop in computeBollingerBands), so each index
                    // shares a time. Points whose time/price fall off-screen map
                    // to null coords — skip them rather than drawing garbage.
                    const upper: { x: number; y: number }[] = [];
                    const lower: { x: number; y: number }[] = [];

                    for (const p of data) {
                        const x = timeScale.timeToCoordinate(p.time as Time);
                        if (x == null) continue;
                        const yU = series.priceToCoordinate(p.upper);
                        const yL = series.priceToCoordinate(p.lower);
                        if (yU == null || yL == null) continue;
                        upper.push({ x, y: yU });
                        lower.push({ x, y: yL });
                    }

                    if (upper.length < 2) return;

                    context.save();
                    context.beginPath();
                    context.moveTo(upper[0]!.x, upper[0]!.y);
                    for (let i = 1; i < upper.length; i++) {
                        context.lineTo(upper[i]!.x, upper[i]!.y);
                    }
                    for (let i = lower.length - 1; i >= 0; i--) {
                        context.lineTo(lower[i]!.x, lower[i]!.y);
                    }
                    context.closePath();
                    context.fillStyle = fill;
                    context.fill();
                    context.restore();
                });
            },
        };
    }
}

export class BollingerFillPrimitive implements ISeriesPrimitive<Time> {
    private _data: BollingerFillPoint[] = [];
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: BollingerFillPaneView[];
    private _fillColor: string;

    constructor(fillColor: string) {
        this._fillColor = fillColor;
        this._paneViews = [new BollingerFillPaneView(this)];
    }

    get data(): BollingerFillPoint[] {
        return this._data;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    get chart(): IChartApi | null {
        return this._chart;
    }

    get fillColor(): string {
        return this._fillColor;
    }

    setData(data: BollingerFillPoint[]): void {
        this._data = data;
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

    updateAllViews(): void {
        // data updated via setData
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
