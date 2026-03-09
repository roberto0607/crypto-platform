import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    IChartApiBase,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { ChartPattern } from "@/api/endpoints/signals";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

/** Format pattern type for display: "DOUBLE_BOTTOM" → "Double Bottom" */
function formatPatternName(type: string): string {
    return type
        .split("_")
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ");
}

class PatternPaneView implements IPrimitivePaneView {
    private _primitive: PatternPrimitive;

    constructor(primitive: PatternPrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const patterns = this._primitive.patterns;
        const series = this._primitive.series;
        const chart = this._primitive.chart;

        return {
            draw(target: RenderTarget) {
                if (!series || !chart || patterns.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    for (const pattern of patterns) {
                        const isBuy = pattern.impliedDirection === "BUY";
                        const mainColor = isBuy ? "34, 197, 94" : "239, 68, 68";
                        const solidColor = isBuy ? "#22c55e" : "#ef4444";

                        // 1. Draw key point markers
                        for (const kp of pattern.keyPoints) {
                            const y = series.priceToCoordinate(kp.price);
                            const x = chart.timeScale().timeToCoordinate(kp.time as unknown as Time);
                            if (y == null || x == null) continue;

                            // Circle marker
                            context.beginPath();
                            context.arc(x, y, 4, 0, Math.PI * 2);
                            context.fillStyle = `rgba(${mainColor}, 0.8)`;
                            context.fill();
                            context.strokeStyle = solidColor;
                            context.lineWidth = 1;
                            context.stroke();

                            // Label
                            context.fillStyle = "#9ca3af";
                            context.font = "9px monospace";
                            context.textAlign = "center";
                            context.fillText(kp.label, x, y - 8);
                        }

                        // 2. Connect key points with dashed lines
                        if (pattern.keyPoints.length >= 2) {
                            context.beginPath();
                            context.setLineDash([4, 4]);
                            context.strokeStyle = `rgba(148, 163, 184, 0.3)`;
                            context.lineWidth = 1;

                            let started = false;
                            for (const kp of pattern.keyPoints) {
                                const y = series.priceToCoordinate(kp.price);
                                const x = chart.timeScale().timeToCoordinate(kp.time as unknown as Time);
                                if (y == null || x == null) continue;

                                if (!started) {
                                    context.moveTo(x, y);
                                    started = true;
                                } else {
                                    context.lineTo(x, y);
                                }
                            }
                            context.stroke();
                            context.setLineDash([]);
                        }

                        // 3. Draw ghost projection line
                        if (pattern.projection.length >= 2) {
                            context.beginPath();
                            context.setLineDash([6, 4]);
                            context.strokeStyle = `rgba(${mainColor}, 0.4)`;
                            context.lineWidth = 2;

                            let started = false;
                            for (const pt of pattern.projection) {
                                const y = series.priceToCoordinate(pt.price);
                                const x = chart.timeScale().timeToCoordinate(pt.time as unknown as Time);
                                if (y == null || x == null) continue;

                                if (!started) {
                                    context.moveTo(x, y);
                                    started = true;
                                } else {
                                    context.lineTo(x, y);
                                }
                            }
                            context.stroke();
                            context.setLineDash([]);
                        }

                        // 4. Draw target price line
                        const targetY = series.priceToCoordinate(pattern.targetPrice);
                        if (targetY != null) {
                            context.beginPath();
                            context.setLineDash([8, 4]);
                            context.strokeStyle = `rgba(${mainColor}, 0.5)`;
                            context.lineWidth = 1;
                            context.moveTo(0, targetY);
                            context.lineTo(mediaSize.width, targetY);
                            context.stroke();
                            context.setLineDash([]);

                            // Target label
                            context.fillStyle = solidColor;
                            context.font = "10px monospace";
                            context.textAlign = "right";
                            context.fillText(
                                `TGT ${pattern.targetPrice.toFixed(0)}`,
                                mediaSize.width - 8,
                                targetY - 4,
                            );
                        }

                        // 5. Draw invalidation price line
                        const invY = series.priceToCoordinate(pattern.invalidationPrice);
                        if (invY != null) {
                            context.beginPath();
                            context.setLineDash([4, 6]);
                            context.strokeStyle = "rgba(107, 114, 128, 0.4)";
                            context.lineWidth = 1;
                            context.moveTo(0, invY);
                            context.lineTo(mediaSize.width, invY);
                            context.stroke();
                            context.setLineDash([]);

                            context.fillStyle = "#6b7280";
                            context.font = "10px monospace";
                            context.textAlign = "right";
                            context.fillText(
                                `INV ${pattern.invalidationPrice.toFixed(0)}`,
                                mediaSize.width - 8,
                                invY - 4,
                            );
                        }

                        // 6. Draw pattern label badge
                        const badgeY = 20;
                        const name = formatPatternName(pattern.type);
                        const prob = Math.round(pattern.completionProb);
                        const arrow = isBuy ? "\u2191" : "\u2193";
                        const line1 = `${name}  ${prob}%  ${pattern.impliedDirection} ${arrow}`;
                        const line2 = `${pattern.status}  ${Math.round(pattern.completionPct)}% formed`;

                        // Badge background
                        const badgeW = 240;
                        const badgeH = 44;
                        const badgeX = mediaSize.width - badgeW - 12;

                        context.fillStyle = "rgba(17, 24, 39, 0.85)";
                        context.strokeStyle = `rgba(${mainColor}, 0.4)`;
                        context.lineWidth = 1;
                        context.beginPath();
                        context.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
                        context.fill();
                        context.stroke();

                        // Line 1: pattern name + prob + direction
                        context.fillStyle = solidColor;
                        context.font = "bold 11px monospace";
                        context.textAlign = "left";
                        context.fillText(line1, badgeX + 8, badgeY + 16);

                        // Progress bar
                        const barX = badgeX + 8;
                        const barY = badgeY + 24;
                        const barW = badgeW - 16;
                        const barH = 4;
                        const fillW = barW * (pattern.completionPct / 100);

                        context.fillStyle = "rgba(75, 85, 99, 0.5)";
                        context.fillRect(barX, barY, barW, barH);
                        context.fillStyle = `rgba(${mainColor}, 0.7)`;
                        context.fillRect(barX, barY, fillW, barH);

                        // Line 2: status
                        context.fillStyle = "#9ca3af";
                        context.font = "10px monospace";
                        context.fillText(line2, badgeX + 8, badgeY + 39);

                        context.textAlign = "left"; // reset
                    }
                });
            },
        };
    }
}

export class PatternPrimitive implements ISeriesPrimitive<Time> {
    private _patterns: ChartPattern[] = [];
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _chart: IChartApiBase<Time> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: PatternPaneView[];

    constructor() {
        this._paneViews = [new PatternPaneView(this)];
    }

    get patterns(): ChartPattern[] {
        return this._patterns;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    get chart(): IChartApiBase<Time> | null {
        return this._chart;
    }

    setPatterns(patterns: ChartPattern[]): void {
        this._patterns = patterns;
        this._requestUpdate?.();
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this._series = param.series as ISeriesApi<"Candlestick">;
        this._chart = param.chart;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._chart = null;
        this._requestUpdate = null;
    }

    updateAllViews(): void {
        // patterns updated via reference
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
