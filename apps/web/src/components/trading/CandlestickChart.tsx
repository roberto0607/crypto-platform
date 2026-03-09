import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    createSeriesMarkers,
    CandlestickSeries,
    LineSeries,
    AreaSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type ISeriesMarkersPluginApi,
    type CandlestickData,
    type Time,
    ColorType,
    type IPriceLine,
    type SeriesMarker,
} from "lightweight-charts";
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { getSignals, type MLSignal } from "@/api/endpoints/signals";
import { useTradingStore } from "@/stores/tradingStore";
import { IndicatorToolbar } from "./IndicatorToolbar";
import {
    ema,
    vwap,
    prevDayHighLow,
    swingPoints,
    type Candle as IndicatorCandle,
    type Point,
} from "@/lib/indicators";
import { detectRegimes, type RegimeType } from "@/lib/regimeDetector";
import { RegimeBandsPrimitive, REGIME_SOLID_COLORS } from "@/lib/regimeBandsPrimitive";
import { ConfidenceHeatmap } from "./ConfidenceHeatmap";
import { LiquidityZonesPrimitive } from "@/lib/liquidityZonesPrimitive";
import { getLiquidityZones } from "@/api/endpoints/signals";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

function candleToLW(c: Candle): CandlestickData<Time> {
    return {
        time: (new Date(c.ts).getTime() / 1000) as Time,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
    };
}

function apiCandleToIndicator(c: Candle): IndicatorCandle {
    return {
        time: new Date(c.ts).getTime() / 1000,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
    };
}

function pointsToLW(points: Point[]): { time: Time; value: number }[] {
    return points.map((p) => ({ time: p.time as Time, value: p.value }));
}

interface OverlaySeries {
    ema200?: ISeriesApi<"Line">;
    ema50?: ISeriesApi<"Line">;
    vwap?: ISeriesApi<"Line">;
    forecastP50?: ISeriesApi<"Line">;
    forecastUpper?: ISeriesApi<"Area">;
    forecastLower?: ISeriesApi<"Area">;
}

const TF_SECONDS: Record<Timeframe, number> = {
    "1m": 60, "5m": 300, "15m": 900,
    "1h": 3600, "4h": 14400, "1d": 86400,
};

function forecastToChartPoints(
    currentPrice: number,
    currentTime: number,
    timeframeSec: number,
    forecast: Record<string, { p10: number; p50: number; p90: number }>,
): { p10: { time: Time; value: number }[]; p50: { time: Time; value: number }[]; p90: { time: Time; value: number }[] } {
    const horizons: [string, number][] = [["t+1", 1], ["t+3", 3], ["t+6", 6], ["t+12", 12]];
    const origin = { time: currentTime as Time, value: currentPrice };

    const p10 = [origin];
    const p50 = [origin];
    const p90 = [origin];

    for (const [key, mult] of horizons) {
        const h = forecast[key];
        if (!h) continue;
        const t = (currentTime + mult * timeframeSec) as Time;
        p10.push({ time: t, value: currentPrice * (1 + h.p10) });
        p50.push({ time: t, value: currentPrice * (1 + h.p50) });
        p90.push({ time: t, value: currentPrice * (1 + h.p90) });
    }

    return { p10, p50, p90 };
}

/** Bucket an epoch-second timestamp to the start of its timeframe period. */
function bucketTime(epochSec: number, tf: Timeframe): number {
    switch (tf) {
        case "1m":  return Math.floor(epochSec / 60) * 60;
        case "5m":  return Math.floor(epochSec / 300) * 300;
        case "15m": return Math.floor(epochSec / 900) * 900;
        case "1h":  return Math.floor(epochSec / 3600) * 3600;
        case "4h":  return Math.floor(epochSec / 14400) * 14400;
        case "1d":  return Math.floor(epochSec / 86400) * 86400;
        default:    return Math.floor(epochSec / 60) * 60;
    }
}

interface CandlestickChartProps {
    onTimeframeChange?: (tf: Timeframe) => void;
}

export function CandlestickChart({ onTimeframeChange }: CandlestickChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const overlayRef = useRef<OverlaySeries>({});
    const priceLinesRef = useRef<IPriceLine[]>([]);
    const signalLinesRef = useRef<IPriceLine[]>([]);
    const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    const rawCandlesRef = useRef<Candle[]>([]);
    const liveCandleRef = useRef<CandlestickData<Time> | null>(null);
    const signalHistoryRef = useRef<MLSignal[]>([]);
    const activeSignalRef = useRef<MLSignal | null>(null);
    const regimePrimitiveRef = useRef<RegimeBandsPrimitive | null>(null);
    const liquidityPrimitiveRef = useRef<LiquidityZonesPrimitive | null>(null);
    const [timeframe, setTimeframe] = useState<Timeframe>("1h");
    const [loading, setLoading] = useState(false);
    const [currentRegime, setCurrentRegime] = useState<RegimeType | null>(null);

    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const indicatorConfig = useTradingStore((s) => s.indicatorConfig);

    // Create chart instance
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: "#0a0a0a" },
                textColor: "#9ca3af",
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { visible: false },
            },
            crosshair: {
                vertLine: { color: "#4b5563", labelBackgroundColor: "#374151" },
                horzLine: { color: "#4b5563", labelBackgroundColor: "#374151" },
            },
            timeScale: {
                borderColor: "#1f2937",
                timeVisible: true,
                secondsVisible: false,
            },
            rightPriceScale: {
                borderColor: "#1f2937",
            },
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: "#22c55e",
            downColor: "#ef4444",
            borderUpColor: "#22c55e",
            borderDownColor: "#ef4444",
            wickUpColor: "#22c55e",
            wickDownColor: "#ef4444",
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Attach regime bands primitive
        const regimePrimitive = new RegimeBandsPrimitive();
        series.attachPrimitive(regimePrimitive);
        regimePrimitiveRef.current = regimePrimitive;

        // Attach liquidity zones primitive
        const liquidityPrimitive = new LiquidityZonesPrimitive();
        series.attachPrimitive(liquidityPrimitive);
        liquidityPrimitiveRef.current = liquidityPrimitive;

        // Responsive resize
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                chart.applyOptions({ width, height });
            }
        });
        observer.observe(containerRef.current);

        return () => {
            observer.disconnect();
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            overlayRef.current = {};
            priceLinesRef.current = [];
            signalLinesRef.current = [];
        };
    }, []);

    // Clear signal price lines
    const clearSignalLines = useCallback(() => {
        const candleSeries = seriesRef.current;
        if (!candleSeries) return;
        for (const pl of signalLinesRef.current) {
            candleSeries.removePriceLine(pl);
        }
        signalLinesRef.current = [];
    }, []);

    // Draw TP/SL lines for an active signal
    const drawSignalLines = useCallback((signal: MLSignal | null) => {
        clearSignalLines();
        const candleSeries = seriesRef.current;
        if (!candleSeries || !signal || signal.outcome !== "pending") return;

        const entry = parseFloat(signal.entryPrice);
        const tp1 = parseFloat(signal.tp1Price);
        const tp2 = parseFloat(signal.tp2Price);
        const tp3 = parseFloat(signal.tp3Price);
        const sl = parseFloat(signal.stopLossPrice);

        // Entry line
        signalLinesRef.current.push(
            candleSeries.createPriceLine({
                price: entry,
                color: "#9ca3af",
                lineWidth: 1,
                lineStyle: LineStyle.Solid,
                axisLabelVisible: true,
                title: "Entry",
            }),
        );

        // TP lines
        signalLinesRef.current.push(
            candleSeries.createPriceLine({
                price: tp1,
                color: "#10b981",
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: `TP1 (${signal.tp1Prob}%)`,
            }),
        );
        signalLinesRef.current.push(
            candleSeries.createPriceLine({
                price: tp2,
                color: "#10b981",
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: `TP2 (${signal.tp2Prob}%)`,
            }),
        );
        signalLinesRef.current.push(
            candleSeries.createPriceLine({
                price: tp3,
                color: "#10b981",
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: `TP3 (${signal.tp3Prob}%)`,
            }),
        );

        // SL line
        signalLinesRef.current.push(
            candleSeries.createPriceLine({
                price: sl,
                color: "#ef4444",
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: "SL",
            }),
        );
    }, [clearSignalLines]);

    // Remove all overlay series and price lines
    const clearOverlays = useCallback(() => {
        const chart = chartRef.current;
        const candleSeries = seriesRef.current;
        if (!chart) return;

        const overlay = overlayRef.current;
        if (overlay.ema200) { chart.removeSeries(overlay.ema200); overlay.ema200 = undefined; }
        if (overlay.ema50) { chart.removeSeries(overlay.ema50); overlay.ema50 = undefined; }
        if (overlay.vwap) { chart.removeSeries(overlay.vwap); overlay.vwap = undefined; }
        if (overlay.forecastP50) { chart.removeSeries(overlay.forecastP50); overlay.forecastP50 = undefined; }
        if (overlay.forecastUpper) { chart.removeSeries(overlay.forecastUpper); overlay.forecastUpper = undefined; }
        if (overlay.forecastLower) { chart.removeSeries(overlay.forecastLower); overlay.forecastLower = undefined; }

        // Remove price lines (PDH/PDL)
        if (candleSeries) {
            for (const pl of priceLinesRef.current) {
                candleSeries.removePriceLine(pl);
            }
        }
        priceLinesRef.current = [];

        // Clear markers (swing + AI combined)
        if (markersPluginRef.current) {
            markersPluginRef.current.detach();
            markersPluginRef.current = null;
        }

        // Clear signal lines
        clearSignalLines();
    }, [clearSignalLines]);

    // Render indicator overlays from raw candle data
    const renderOverlays = useCallback((candles: Candle[]) => {
        const chart = chartRef.current;
        const candleSeries = seriesRef.current;
        if (!chart || !candleSeries || candles.length === 0) return;

        clearOverlays();

        const indCandles = candles.map(apiCandleToIndicator);

        // EMA 200
        if (indicatorConfig.ema200) {
            const series = chart.addSeries(LineSeries, {
                color: "#a855f7",
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            series.setData(pointsToLW(ema(indCandles, 200)));
            overlayRef.current.ema200 = series;
        }

        // EMA 50
        if (indicatorConfig.ema50) {
            const series = chart.addSeries(LineSeries, {
                color: "#eab308",
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            series.setData(pointsToLW(ema(indCandles, 50)));
            overlayRef.current.ema50 = series;
        }

        // VWAP
        if (indicatorConfig.vwap) {
            const series = chart.addSeries(LineSeries, {
                color: "#06b6d4",
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            series.setData(pointsToLW(vwap(indCandles)));
            overlayRef.current.vwap = series;
        }

        // Key Levels — PDH/PDL
        if (indicatorConfig.keyLevels) {
            const levels = prevDayHighLow(indCandles);
            if (levels) {
                const pdhLine = candleSeries.createPriceLine({
                    price: levels.pdh,
                    color: "#94a3b8",
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: "PDH",
                });
                const pdlLine = candleSeries.createPriceLine({
                    price: levels.pdl,
                    color: "#94a3b8",
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: "PDL",
                });
                priceLinesRef.current.push(pdhLine, pdlLine);
            }
        }

        // Build combined markers: swing points + AI signals
        const markers: SeriesMarker<Time>[] = [];

        // Swing Points
        if (indicatorConfig.swingPoints) {
            const swings = swingPoints(indCandles);
            for (const h of swings.highs) {
                markers.push({
                    time: h.time as Time,
                    position: "aboveBar",
                    shape: "arrowDown",
                    color: "#ef4444",
                    text: "SH",
                });
            }
            for (const l of swings.lows) {
                markers.push({
                    time: l.time as Time,
                    position: "belowBar",
                    shape: "arrowUp",
                    color: "#22c55e",
                    text: "SL",
                });
            }
        }

        // AI Signal markers
        if (indicatorConfig.aiSignals && signalHistoryRef.current.length > 0) {
            for (const sig of signalHistoryRef.current) {
                const sigTime = Math.floor(new Date(sig.createdAt).getTime() / 1000) as Time;
                const isBuy = sig.signalType === "BUY";

                markers.push({
                    time: sigTime,
                    position: isBuy ? "belowBar" : "aboveBar",
                    shape: isBuy ? "arrowUp" : "arrowDown",
                    color: isBuy ? "#10b981" : "#ef4444",
                    text: `${sig.signalType} ${sig.confidence}%`,
                });
            }

            // Draw TP/SL lines for active signal
            drawSignalLines(activeSignalRef.current);
        }

        // Sort and render all markers
        if (markers.length > 0) {
            markers.sort((a, b) => (a.time as number) - (b.time as number));
            markersPluginRef.current = createSeriesMarkers(candleSeries, markers);
        }

        // Forecast cone
        if (indicatorConfig.forecastCone && activeSignalRef.current?.forecast) {
            const lastCandle = candles[candles.length - 1];
            if (lastCandle) {
                const currentPrice = parseFloat(lastCandle.close);
                const currentTime = Math.floor(new Date(lastCandle.ts).getTime() / 1000);
                const tfSec = TF_SECONDS[timeframe] ?? 3600;
                const { p10, p50, p90 } = forecastToChartPoints(
                    currentPrice, currentTime, tfSec, activeSignalRef.current.forecast,
                );

                // p50 median line — dashed cyan
                const p50Series = chart.addSeries(LineSeries, {
                    color: "#06b6d4",
                    lineWidth: 2,
                    lineStyle: LineStyle.Dashed,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                });
                p50Series.setData(p50);
                overlayRef.current.forecastP50 = p50Series;

                // Upper area (p90 → p50 fill)
                const upperSeries = chart.addSeries(AreaSeries, {
                    lineColor: "rgba(6,182,212,0.3)",
                    lineWidth: 1,
                    topColor: "rgba(6,182,212,0.08)",
                    bottomColor: "transparent",
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                });
                upperSeries.setData(p90);
                overlayRef.current.forecastUpper = upperSeries;

                // Lower area (p10 → transparent fill)
                const lowerSeries = chart.addSeries(AreaSeries, {
                    lineColor: "rgba(6,182,212,0.3)",
                    lineWidth: 1,
                    topColor: "transparent",
                    bottomColor: "rgba(6,182,212,0.08)",
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                });
                lowerSeries.setData(p10);
                overlayRef.current.forecastLower = lowerSeries;
            }
        }

        // Regime bands
        if (indicatorConfig.regimeBands) {
            const segments = detectRegimes(indCandles);
            regimePrimitiveRef.current?.setSegments(segments);
            // Set current regime from last segment
            if (segments.length > 0) {
                setCurrentRegime(segments[segments.length - 1]!.regime);
            } else {
                setCurrentRegime(null);
            }
        } else {
            regimePrimitiveRef.current?.setSegments([]);
            setCurrentRegime(null);
        }

        // Liquidity zones are fetched separately and set via primitive ref
        // (not computed from candle data — they come from the API)
        if (!indicatorConfig.liquidityZones) {
            liquidityPrimitiveRef.current?.setZones([]);
        }
    }, [indicatorConfig, clearOverlays, drawSignalLines, timeframe]);

    // Fetch signals for the current pair + timeframe
    const needsSignals = indicatorConfig.aiSignals || indicatorConfig.forecastCone;

    const fetchSignals = useCallback(async () => {
        if (!selectedPairId || !needsSignals) {
            signalHistoryRef.current = [];
            activeSignalRef.current = null;
            return;
        }

        try {
            const { data } = await getSignals(selectedPairId, { timeframe, limit: 20 });
            signalHistoryRef.current = data.history;
            activeSignalRef.current = data.active;
        } catch {
            signalHistoryRef.current = [];
            activeSignalRef.current = null;
        }
    }, [selectedPairId, timeframe, needsSignals]);

    // Fetch candles when pair or timeframe changes
    const fetchCandles = useCallback(async () => {
        if (!selectedPairId || !seriesRef.current) return;

        setLoading(true);
        try {
            // Fetch candles and signals in parallel
            const [candleRes] = await Promise.all([
                getCandles(selectedPairId, { timeframe, limit: 300 }),
                fetchSignals(),
            ]);

            rawCandlesRef.current = candleRes.data.candles;
            liveCandleRef.current = null; // Reset live candle on fresh fetch
            const lwData = candleRes.data.candles.map(candleToLW);
            seriesRef.current.setData(lwData);

            // Render indicator overlays (includes AI signals)
            renderOverlays(candleRes.data.candles);

            // Fit content to show all candles
            chartRef.current?.timeScale().fitContent();
        } catch {
            // Non-fatal — chart shows empty
        } finally {
            setLoading(false);
        }
    }, [selectedPairId, timeframe, renderOverlays, fetchSignals]);

    useEffect(() => {
        fetchCandles();
    }, [fetchCandles]);

    // Re-render overlays when indicator config changes (without re-fetching candles)
    useEffect(() => {
        if (rawCandlesRef.current.length > 0) {
            // If signals are needed but not yet loaded, fetch first
            if (needsSignals && signalHistoryRef.current.length === 0 && !activeSignalRef.current) {
                fetchSignals().then(() => {
                    renderOverlays(rawCandlesRef.current);
                });
            } else {
                if (!needsSignals) {
                    signalHistoryRef.current = [];
                    activeSignalRef.current = null;
                }
                renderOverlays(rawCandlesRef.current);
            }
        }
    }, [renderOverlays, fetchSignals, needsSignals]);

    // Live update: price.tick → update current candle with proper OHLC tracking
    useEffect(() => {
        if (!selectedPairId) return;

        const handlePriceTick = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId || !seriesRef.current) return;

            const price = parseFloat(detail.last);
            const now = Math.floor(Date.now() / 1000);
            const candleTime = bucketTime(now, timeframe) as Time;

            const live = liveCandleRef.current;
            if (live && live.time === candleTime) {
                // Same candle period — preserve open, track high/low, update close
                live.high = Math.max(live.high, price);
                live.low = Math.min(live.low, price);
                live.close = price;
            } else {
                // New candle period — start fresh
                liveCandleRef.current = {
                    time: candleTime,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                };
            }

            seriesRef.current.update(liveCandleRef.current!);
        };

        window.addEventListener("sse:price.tick", handlePriceTick);
        return () => window.removeEventListener("sse:price.tick", handlePriceTick);
    }, [selectedPairId, timeframe]);

    // Live update: candle.closed → append completed candle + update overlays incrementally
    useEffect(() => {
        if (!selectedPairId) return;

        const handleCandleClosed = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId || !seriesRef.current) return;
            if (detail.timeframe !== timeframe) return;

            seriesRef.current.update({
                time: (detail.ts / 1000) as Time,
                open: parseFloat(detail.open),
                high: parseFloat(detail.high),
                low: parseFloat(detail.low),
                close: parseFloat(detail.close),
            });

            // Reset live candle so the next tick starts a fresh one
            liveCandleRef.current = null;

            // Append to raw candles and re-render overlays
            const newCandle: Candle = {
                ts: new Date(detail.ts).toISOString(),
                open: detail.open,
                high: detail.high,
                low: detail.low,
                close: detail.close,
                volume: detail.volume ?? "0",
            };
            rawCandlesRef.current = [...rawCandlesRef.current, newCandle];
            renderOverlays(rawCandlesRef.current);
        };

        window.addEventListener("sse:candle.closed", handleCandleClosed);
        return () => window.removeEventListener("sse:candle.closed", handleCandleClosed);
    }, [selectedPairId, timeframe, renderOverlays]);

    // Live update: signal.new → refetch signals and re-render
    useEffect(() => {
        if (!selectedPairId || !needsSignals) return;

        const handleSignalNew = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId) return;

            fetchSignals().then(() => {
                if (rawCandlesRef.current.length > 0) {
                    renderOverlays(rawCandlesRef.current);
                }
            });
        };

        window.addEventListener("sse:signal.new", handleSignalNew);
        return () => window.removeEventListener("sse:signal.new", handleSignalNew);
    }, [selectedPairId, needsSignals, fetchSignals, renderOverlays]);

    // Liquidity zones: fetch on mount + 60s refresh
    useEffect(() => {
        if (!selectedPairId || !indicatorConfig.liquidityZones) {
            liquidityPrimitiveRef.current?.setZones([]);
            return;
        }

        const fetchZones = async () => {
            try {
                const { data } = await getLiquidityZones(selectedPairId, { timeframe });
                liquidityPrimitiveRef.current?.setZones(data.zones);
            } catch {
                // Non-fatal
            }
        };

        fetchZones();
        const interval = setInterval(fetchZones, 60_000);
        return () => clearInterval(interval);
    }, [selectedPairId, timeframe, indicatorConfig.liquidityZones]);

    const handleTimeframeChange = (tf: Timeframe) => {
        setTimeframe(tf);
        onTimeframeChange?.(tf);
    };

    return (
        <div className="flex flex-col h-full">
            {/* Timeframe selector + Indicator toolbar */}
            <div className="flex items-center gap-1 mb-2">
                {TIMEFRAMES.map((tf) => (
                    <button
                        key={tf}
                        onClick={() => handleTimeframeChange(tf)}
                        className={`px-2 py-1 text-xs rounded transition-colors ${
                            timeframe === tf
                                ? "bg-blue-600 text-white"
                                : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                        }`}
                    >
                        {tf}
                    </button>
                ))}
                <div className="ml-2">
                    <IndicatorToolbar />
                </div>
                {loading && (
                    <span className="text-gray-600 text-xs ml-2">Loading...</span>
                )}
            </div>

            {/* Chart container */}
            <div className="relative flex-1 min-h-0">
                <div ref={containerRef} className="absolute inset-0" />
                {indicatorConfig.regimeBands && currentRegime && (
                    <div className="absolute top-2 right-2 bg-gray-900/80 px-2 py-1 rounded text-xs flex items-center gap-1.5 z-10">
                        <span
                            className="w-2.5 h-2.5 rounded-sm"
                            style={{ backgroundColor: REGIME_SOLID_COLORS[currentRegime] }}
                        />
                        <span className="text-gray-300">
                            {currentRegime.replace("_", " ")}
                        </span>
                    </div>
                )}
            </div>

            {/* Confidence heatmap (40px) */}
            {indicatorConfig.confidenceHeatmap && selectedPairId && (
                <ConfidenceHeatmap
                    pairId={selectedPairId}
                    timeframe={timeframe}
                    mainChart={chartRef.current}
                />
            )}
        </div>
    );
}
