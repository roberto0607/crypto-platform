import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IChartApi,
    IPrimitivePaneView,
    PrimitiveHoveredItem,
} from "lightweight-charts";
import type { StoredDrawing } from "@/stores/drawingStore";

/**
 * Shared boilerplate for every drawing-tool primitive (attached series/chart
 * refs, selected-state toggle, requestUpdate wiring) — same shape as
 * BollingerFillPrimitive/LiquidationLevelsPrimitive, generalized so each tool
 * subclass only implements paneViews() (render) and hitTest() (selection).
 *
 * One instance per PLACED drawing (not one shared instance per tool type) —
 * CandlestickChart.tsx attaches/detaches one of these per entry in
 * drawingStore's `drawings` array.
 */
export abstract class BaseDrawingPrimitive<T extends StoredDrawing> implements ISeriesPrimitive<Time> {
    protected _data: T;
    protected _selected = false;
    protected _series: ISeriesApi<"Candlestick"> | null = null;
    protected _chart: IChartApi | null = null;
    protected _requestUpdate: (() => void) | null = null;

    constructor(data: T) {
        this._data = data;
    }

    get data(): T {
        return this._data;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    get chart(): IChartApi | null {
        return this._chart;
    }

    get selected(): boolean {
        return this._selected;
    }

    setChart(chart: IChartApi): void {
        this._chart = chart;
    }

    setData(data: T): void {
        this._data = data;
        this._requestUpdate?.();
    }

    setSelected(selected: boolean): void {
        if (this._selected === selected) return;
        this._selected = selected;
        this._requestUpdate?.();
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this._series = param.series as ISeriesApi<"Candlestick">;
        this._requestUpdate = param.requestUpdate;
        // Data is injected via the constructor (one instance per placed
        // drawing, unlike the always-on indicator primitives which start
        // empty and get their first paint triggered by a post-attach
        // setData/update() call) — force that first paint here instead.
        this._requestUpdate();
    }

    detached(): void {
        this._series = null;
        this._chart = null;
        this._requestUpdate = null;
    }

    updateAllViews(): void {
        // Data/selection updated via setData/setSelected, both of which
        // already call _requestUpdate.
    }

    abstract paneViews(): readonly IPrimitivePaneView[];
    abstract hitTest(x: number, y: number): PrimitiveHoveredItem | null;
}
