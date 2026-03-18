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

export interface PdhPdlZoneData {
    pdh: number;
    pdl: number;
    currentPrice: number;
    pdhProximity: boolean;
    pdlProximity: boolean;
}

class PdhPdlMainPaneView implements IPrimitivePaneView {
    private _primitive: PdhPdlZonePrimitive;

    constructor(primitive: PdhPdlZonePrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const data = this._primitive.data;
        const series = this._primitive.series;

        return {
            draw(target: RenderTarget) {
                if (!series || !data) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    const yPrice = series.priceToCoordinate(data.currentPrice);
                    const yPdh = series.priceToCoordinate(data.pdh);
                    const yPdl = series.priceToCoordinate(data.pdl);

                    if (yPdh == null || yPdl == null) return;

                    // ── Zone fills ──
                    if (yPrice != null) {
                        // Red fill between price and PDH
                        if (data.currentPrice < data.pdh) {
                            const top = Math.min(yPrice, yPdh);
                            const h = Math.abs(yPrice - yPdh);
                            context.fillStyle = "rgba(255, 77, 77, 0.04)";
                            context.fillRect(0, top, mediaSize.width, h);
                        }

                        // Green fill between price and PDL
                        if (data.currentPrice > data.pdl) {
                            const top = Math.min(yPrice, yPdl);
                            const h = Math.abs(yPrice - yPdl);
                            context.fillStyle = "rgba(0, 230, 118, 0.04)";
                            context.fillRect(0, top, mediaSize.width, h);
                        }
                    }

                    // ── Dashed lines ──
                    context.save();
                    context.setLineDash([6, 4]);

                    // PDH line
                    if (data.pdhProximity) {
                        // Proximity: full intensity, thick
                        context.strokeStyle = "#ff4d4d";
                        context.lineWidth = 2;
                    } else if (data.pdlProximity) {
                        // Other level in proximity: dim this one
                        context.strokeStyle = "rgba(255, 77, 77, 0.35)";
                        context.lineWidth = 1;
                    } else {
                        // Normal: 0.9 opacity
                        context.strokeStyle = "rgba(255, 77, 77, 0.9)";
                        context.lineWidth = 1;
                    }
                    context.beginPath();
                    context.moveTo(0, yPdh);
                    context.lineTo(mediaSize.width, yPdh);
                    context.stroke();

                    // PDL line
                    if (data.pdlProximity) {
                        // Proximity: full intensity, thick
                        context.strokeStyle = "#00e676";
                        context.lineWidth = 2;
                    } else if (data.pdhProximity) {
                        // Other level in proximity: dim this one
                        context.strokeStyle = "rgba(0, 230, 118, 0.35)";
                        context.lineWidth = 1;
                    } else {
                        // Normal: 0.55 opacity (subdued — price is far above PDL)
                        context.strokeStyle = "rgba(0, 230, 118, 0.55)";
                        context.lineWidth = 1;
                    }
                    context.beginPath();
                    context.moveTo(0, yPdl);
                    context.lineTo(mediaSize.width, yPdl);
                    context.stroke();

                    context.restore();
                });
            },
        };
    }
}

export class PdhPdlZonePrimitive implements ISeriesPrimitive<Time> {
    private _data: PdhPdlZoneData | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: PdhPdlMainPaneView[];

    constructor() {
        this._paneViews = [new PdhPdlMainPaneView(this)];
    }

    get data(): PdhPdlZoneData | null {
        return this._data;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    setData(data: PdhPdlZoneData | null): void {
        this._data = data;
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
        // data updated via setData
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
