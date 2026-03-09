import type {
    ISeriesPrimitive,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    IChartApiBase,
    SeriesType,
    IPrimitivePaneView,
} from "lightweight-charts";
import type { PriceScenario, GhostCandle } from "@/api/endpoints/signals";

interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

const SCENARIO_COLORS: Record<string, { up: string; down: string; wick: string }> = {
    bull: {
        up: "34, 197, 94",
        down: "22, 163, 74",
        wick: "34, 197, 94",
    },
    base: {
        up: "209, 213, 219",
        down: "156, 163, 175",
        wick: "156, 163, 175",
    },
    bear: {
        up: "248, 113, 113",
        down: "239, 68, 68",
        wick: "239, 68, 68",
    },
};

function ghostAlpha(candle: GhostCandle, scenarioProbability: number): number {
    const probAlpha = 0.15 + scenarioProbability * 0.35;
    return probAlpha * candle.confidence;
}

class GhostCandlePaneView implements IPrimitivePaneView {
    private _primitive: GhostCandlePrimitive;

    constructor(primitive: GhostCandlePrimitive) {
        this._primitive = primitive;
    }

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const scenarios = this._primitive.scenarios;
        const series = this._primitive.series;
        const chart = this._primitive.chart;
        const lastRealTime = this._primitive.lastRealTime;

        return {
            draw(target: RenderTarget) {
                if (!series || !chart || scenarios.length === 0) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                    // 1. Draw separator line between real and ghost candles
                    if (lastRealTime != null) {
                        const sepX = chart.timeScale().timeToCoordinate(lastRealTime);
                        if (sepX != null) {
                            context.save();
                            context.setLineDash([4, 4]);
                            context.strokeStyle = "rgba(107, 114, 128, 0.3)";
                            context.lineWidth = 1;
                            context.beginPath();
                            context.moveTo(sepX, 0);
                            context.lineTo(sepX, mediaSize.height);
                            context.stroke();
                            context.setLineDash([]);

                            // Label
                            context.fillStyle = "rgba(107, 114, 128, 0.5)";
                            context.font = "10px sans-serif";
                            context.textAlign = "left";
                            context.fillText("AI Predicted \u2192", sepX + 4, 14);
                            context.restore();
                        }
                    }

                    // 2. Draw ghost candles for each scenario
                    for (const scenario of scenarios) {
                        const colors = SCENARIO_COLORS[scenario.name] ?? SCENARIO_COLORS["base"]!;

                        for (const candle of scenario.candles) {
                            const alpha = ghostAlpha(candle, scenario.probability);
                            const candleTime = (new Date(candle.ts).getTime() / 1000) as unknown as Time;

                            const x = chart.timeScale().timeToCoordinate(candleTime);
                            if (x == null) continue;

                            const oY = series.priceToCoordinate(candle.open);
                            const hY = series.priceToCoordinate(candle.high);
                            const lY = series.priceToCoordinate(candle.low);
                            const cY = series.priceToCoordinate(candle.close);
                            if (oY == null || hY == null || lY == null || cY == null) continue;

                            const isBullish = candle.close >= candle.open;
                            const bodyColor = isBullish
                                ? `rgba(${colors.up}, ${alpha})`
                                : `rgba(${colors.down}, ${alpha})`;
                            const wickColor = `rgba(${colors.wick}, ${alpha * 0.7})`;

                            // Candle width — narrower than real candles
                            const candleWidth = Math.max(3, 5);

                            // Draw wick
                            context.strokeStyle = wickColor;
                            context.lineWidth = 1;
                            context.beginPath();
                            context.moveTo(x, hY);
                            context.lineTo(x, lY);
                            context.stroke();

                            // Draw body
                            context.fillStyle = bodyColor;
                            const bodyTop = Math.min(oY, cY);
                            const bodyHeight = Math.max(1, Math.abs(oY - cY));
                            context.fillRect(
                                x - candleWidth / 2,
                                bodyTop,
                                candleWidth,
                                bodyHeight,
                            );
                        }
                    }

                    // 3. Draw scenario labels at the end of each path
                    for (const scenario of scenarios) {
                        if (scenario.candles.length === 0) continue;

                        const lastCandle = scenario.candles[scenario.candles.length - 1]!;
                        const lastTime = (new Date(lastCandle.ts).getTime() / 1000) as unknown as Time;
                        const lastX = chart.timeScale().timeToCoordinate(lastTime);
                        const lastY = series.priceToCoordinate(lastCandle.close);
                        if (lastX == null || lastY == null) continue;

                        const colors = SCENARIO_COLORS[scenario.name] ?? SCENARIO_COLORS["base"]!;
                        const prob = Math.round(scenario.probability * 100);
                        const arrow = scenario.name === "bull" ? "\u25B2" :
                                      scenario.name === "bear" ? "\u25BC" : "\u25CF";

                        const label = `${arrow} ${scenario.name.charAt(0).toUpperCase() + scenario.name.slice(1)} ${prob}%  $${scenario.finalPrice.toLocaleString()}`;

                        // Background pill
                        context.font = "10px monospace";
                        const textW = context.measureText(label).width;
                        const pillW = textW + 12;
                        const pillH = 18;
                        const pillX = lastX + 8;
                        const pillY = lastY - pillH / 2;

                        context.fillStyle = "rgba(17, 24, 39, 0.85)";
                        context.strokeStyle = `rgba(${colors.up}, 0.4)`;
                        context.lineWidth = 1;
                        context.beginPath();
                        context.roundRect(pillX, pillY, pillW, pillH, 3);
                        context.fill();
                        context.stroke();

                        // Text
                        const isBull = scenario.name === "bull";
                        const isBear = scenario.name === "bear";
                        context.fillStyle = isBull ? "#22c55e" : isBear ? "#ef4444" : "#9ca3af";
                        context.textAlign = "left";
                        context.fillText(label, pillX + 6, pillY + 13);
                    }
                });
            },
        };
    }
}

export class GhostCandlePrimitive implements ISeriesPrimitive<Time> {
    private _scenarios: PriceScenario[] = [];
    private _series: ISeriesApi<"Candlestick"> | null = null;
    private _chart: IChartApiBase<Time> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _paneViews: GhostCandlePaneView[];
    private _lastRealTime: Time | null = null;

    constructor() {
        this._paneViews = [new GhostCandlePaneView(this)];
    }

    get scenarios(): PriceScenario[] {
        return this._scenarios;
    }

    get series(): ISeriesApi<"Candlestick"> | null {
        return this._series;
    }

    get chart(): IChartApiBase<Time> | null {
        return this._chart;
    }

    get lastRealTime(): Time | null {
        return this._lastRealTime;
    }

    setScenarios(scenarios: PriceScenario[], lastRealTime?: Time): void {
        this._scenarios = scenarios;
        if (lastRealTime !== undefined) {
            this._lastRealTime = lastRealTime;
        }
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
        // scenarios updated via reference
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }
}
