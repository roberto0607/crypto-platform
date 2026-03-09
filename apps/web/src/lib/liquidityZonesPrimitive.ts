import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { LiquidityZone } from "@/api/endpoints/signals";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

class LiquidityZonesPaneView implements IPrimitivePaneView {
    private _primitive: LiquidityZonesPrimitive;

    constructor(primitive: LiquidityZonesPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const zones = this._primitive.zones;
        const series = this._primitive.series;

        return {
            draw(target: RenderTarget) {
                if (!series || zones.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    for (const zone of zones) {
                        const yCenter = series.priceToCoordinate(zone.price);
                        const yTop = series.priceToCoordinate(zone.price + zone.width / 2);
                        const yBottom = series.priceToCoordinate(zone.price - zone.width / 2);

                        if (yCenter == null || yTop == null || yBottom == null) continue;

                        const height = Math.abs(yBottom - yTop);
                        const top = Math.min(yTop, yBottom);
                        const alpha = 0.04 + (zone.strength / 100) * 0.11;

                        const isSupport = zone.type === "support";
                        const baseColor = isSupport ? "34, 197, 94" : "239, 68, 68";

                        // Outer glow (softer, wider)
                        context.fillStyle = `rgba(${baseColor}, ${alpha * 0.4})`;
                        context.fillRect(0, top - 2, mediaSize.width, height + 4);

                        // Inner band
                        context.fillStyle = `rgba(${baseColor}, ${alpha})`;
                        context.fillRect(0, top, mediaSize.width, height);

                        // Strength label on right edge
                        context.fillStyle = isSupport ? "#22c55e" : "#ef4444";
                        context.font = "10px monospace";
                        context.textAlign = "right";
                        const label = `${zone.strength} ${zone.sources.join("·")}`;
                        context.fillText(label, mediaSize.width - 8, top + height / 2 + 3);
                        context.textAlign = "left"; // reset
                    }
                });
            },
        };
    }
}

export class LiquidityZonesPrimitive implements ISeriesPrimitive<Time> {
    private _zones: LiquidityZone[] = [];
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: LiquidityZonesPaneView[];

    constructor() {
        this._paneViews = [new LiquidityZonesPaneView(this)];
    }

    get zones(): LiquidityZone[] {
        return this._zones;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    setZones(zones: LiquidityZone[]): void {
        this._zones = zones;
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
        // zones updated via reference
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
