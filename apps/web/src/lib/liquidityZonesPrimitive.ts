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
    constructor(_primitive: LiquidityZonesPrimitive) {
        // primitive kept for interface compliance; rendering is DOM-based
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        // Gradient bands and anchor lines are rendered as DOM elements
        // in CandlestickChart.tsx for reliable CSS gradient support.
        return {
            draw(_target: RenderTarget) {
                // no-op — DOM rendering handles visuals
            },
        };
    }
}

/** Parse estimatedLiquidity ("high"/"medium"/"low") to a numeric score */
function parseLiquidity(value: string): number {
    if (value === "high") return 100;
    if (value === "medium") return 60;
    if (value === "low") return 25;
    // fallback for any legacy dollar string format
    const n = parseFloat(value.replace(/[$,KMB]/g, ""));
    if (isNaN(n)) return 0;
    if (value.includes("B")) return n * 1_000_000_000;
    if (value.includes("M")) return n * 1_000_000;
    if (value.includes("K")) return n * 1_000;
    return n;
}

export class LiquidityZonesPrimitive implements ISeriesPrimitive<Time> {
    private _zones: LiquidityZone[] = [];
    private _currentPrice = 0;
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

    get currentPrice(): number {
        return this._currentPrice;
    }

    setZones(zones: LiquidityZone[]): void {
        this._zones = zones;
        this._requestUpdate?.();
    }

    setCurrentPrice(price: number): void {
        this._currentPrice = price;
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

/** Format liquidity label for pill display */
export function formatLiquidity(value: string): string {
    if (value === "high") return "HIGH";
    if (value === "medium") return "MED";
    if (value === "low") return "LOW";
    return value; // legacy dollar format passthrough
}

/** Parse liquidity for external use */
export { parseLiquidity };
