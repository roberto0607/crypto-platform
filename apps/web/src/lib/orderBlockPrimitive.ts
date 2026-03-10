import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { OrderBlock } from "./orderBlocks";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

class OrderBlockPaneView implements IPrimitivePaneView {
    private _primitive: OrderBlockPrimitive;

    constructor(primitive: OrderBlockPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "bottom" {
        return "bottom";
    }

    renderer() {
        const blocks = this._primitive.blocks;
        const series = this._primitive.series;

        return {
            draw(target: RenderTarget) {
                if (!series || blocks.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    for (const ob of blocks) {
                        const yTop = series.priceToCoordinate(ob.top);
                        const yBottom = series.priceToCoordinate(ob.bottom);

                        if (yTop == null || yBottom == null) continue;

                        const top = Math.min(yTop, yBottom);
                        const height = Math.abs(yBottom - yTop);

                        const isBullish = ob.type === "bullish";
                        const baseColor = isBullish ? "34, 197, 94" : "239, 68, 68";

                        // Zone fill
                        context.fillStyle = `rgba(${baseColor}, 0.08)`;
                        context.fillRect(0, top, mediaSize.width, height);

                        // Border lines (top and bottom edges)
                        context.strokeStyle = `rgba(${baseColor}, 0.25)`;
                        context.lineWidth = 1;
                        context.beginPath();
                        context.moveTo(0, top);
                        context.lineTo(mediaSize.width, top);
                        context.moveTo(0, top + height);
                        context.lineTo(mediaSize.width, top + height);
                        context.stroke();

                        // Label on right edge
                        context.fillStyle = isBullish ? "#22c55e" : "#ef4444";
                        context.font = "10px monospace";
                        context.textAlign = "right";
                        context.fillText("OB", mediaSize.width - 8, top + height / 2 + 3);
                        context.textAlign = "left";
                    }
                });
            },
        };
    }
}

export class OrderBlockPrimitive implements ISeriesPrimitive<Time> {
    private _blocks: OrderBlock[] = [];
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: OrderBlockPaneView[];

    constructor() {
        this._paneViews = [new OrderBlockPaneView(this)];
    }

    get blocks(): OrderBlock[] {
        return this._blocks;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    setBlocks(blocks: OrderBlock[]): void {
        this._blocks = blocks;
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
        // blocks updated via reference
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
