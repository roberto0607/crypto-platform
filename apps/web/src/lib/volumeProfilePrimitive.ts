import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { VolumeProfileData } from "./volumeProfile";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

class VolumeProfilePaneView implements IPrimitivePaneView {
    private _primitive: VolumeProfilePrimitive;

    constructor(primitive: VolumeProfilePrimitive) {
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
                if (!series || !data || data.levels.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    // Find max volume for normalization
                    let maxVol = 0;
                    for (const level of data.levels) {
                        if (level.totalVolume > maxVol) maxVol = level.totalVolume;
                    }
                    if (maxVol === 0) return;

                    const maxBarWidth = mediaSize.width * 0.15;

                    for (const level of data.levels) {
                        if (level.totalVolume === 0) continue;

                        const bucketSize = data.levels.length > 1
                            ? Math.abs(data.levels[1]!.price - data.levels[0]!.price)
                            : 1;

                        const yTop = series.priceToCoordinate(level.price + bucketSize / 2);
                        const yBottom = series.priceToCoordinate(level.price - bucketSize / 2);

                        if (yTop == null || yBottom == null) continue;

                        const top = Math.min(yTop, yBottom);
                        const height = Math.max(Math.abs(yBottom - yTop) - 1, 1);

                        const barWidth = (level.totalVolume / maxVol) * maxBarWidth;
                        const x = mediaSize.width - barWidth;

                        // Buy portion (green)
                        const buyRatio = level.totalVolume > 0 ? level.buyVolume / level.totalVolume : 0.5;
                        const buyWidth = barWidth * buyRatio;
                        const sellWidth = barWidth - buyWidth;

                        // Sell volume (red, from right edge)
                        if (sellWidth > 0) {
                            context.fillStyle = "rgba(239, 68, 68, 0.15)";
                            context.fillRect(x, top, sellWidth, height);
                        }

                        // Buy volume (green, after sell)
                        if (buyWidth > 0) {
                            context.fillStyle = "rgba(34, 197, 94, 0.15)";
                            context.fillRect(x + sellWidth, top, buyWidth, height);
                        }
                    }

                    // POC line — dotted white
                    const pocY = series.priceToCoordinate(data.poc);
                    if (pocY != null) {
                        context.strokeStyle = "rgba(255, 255, 255, 0.4)";
                        context.lineWidth = 1;
                        context.setLineDash([3, 3]);
                        context.beginPath();
                        context.moveTo(0, pocY);
                        context.lineTo(mediaSize.width, pocY);
                        context.stroke();

                        // POC label
                        context.fillStyle = "rgba(255, 255, 255, 0.5)";
                        context.font = "10px monospace";
                        context.textAlign = "left";
                        context.fillText("POC", 4, pocY - 3);
                    }

                    // VAH/VAL lines — dotted gray
                    context.strokeStyle = "rgba(107, 114, 128, 0.3)";
                    context.setLineDash([4, 4]);

                    const vahY = series.priceToCoordinate(data.vah);
                    if (vahY != null) {
                        context.beginPath();
                        context.moveTo(0, vahY);
                        context.lineTo(mediaSize.width, vahY);
                        context.stroke();

                        context.fillStyle = "rgba(107, 114, 128, 0.4)";
                        context.font = "10px monospace";
                        context.textAlign = "left";
                        context.fillText("VAH", 4, vahY - 3);
                    }

                    const valY = series.priceToCoordinate(data.val);
                    if (valY != null) {
                        context.beginPath();
                        context.moveTo(0, valY);
                        context.lineTo(mediaSize.width, valY);
                        context.stroke();

                        context.fillStyle = "rgba(107, 114, 128, 0.4)";
                        context.font = "10px monospace";
                        context.textAlign = "left";
                        context.fillText("VAL", 4, valY - 3);
                    }

                    context.setLineDash([]);
                });
            },
        };
    }
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
    private _data: VolumeProfileData | null = null;
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: VolumeProfilePaneView[];

    constructor() {
        this._paneViews = [new VolumeProfilePaneView(this)];
    }

    get data(): VolumeProfileData | null {
        return this._data;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    setData(data: VolumeProfileData | null): void {
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
        // data updated via reference
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
