import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    CandlestickSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type CandlestickData,
    type Time,
    ColorType,
    type IPriceLine,
} from "lightweight-charts";
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { useTradingStore } from "@/stores/tradingStore";
import { IndicatorToolbar } from "./IndicatorToolbar";
import {
    prevDayHighLow,
    type Candle as IndicatorCandle,
} from "@/lib/indicators";
import { LiquidityZonesPrimitive } from "@/lib/liquidityZonesPrimitive";
import { OrderBlockPrimitive } from "@/lib/orderBlockPrimitive";
import { FvgPrimitive } from "@/lib/fvgPrimitive";
import { detectOrderBlocks, type OrderBlock } from "@/lib/orderBlocks";
import { detectFairValueGaps, type FairValueGap } from "@/lib/fairValueGaps";
import { getLiquidityZones, type LiquidityZone } from "@/api/endpoints/signals";
import { computeCVD, detectCvdDivergence, type CvdPoint } from "@/lib/cvd";
import { CvdPanel } from "./CvdPanel";
import { VolumeProfilePrimitive } from "@/lib/volumeProfilePrimitive";
import { computeVolumeProfile } from "@/lib/volumeProfile";
import { computeTradeSetup, type TradeSetup } from "@/lib/confluenceEngine";

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
    onTradeSetupChange?: (setup: TradeSetup | null) => void;
    fundingRate?: number;
}

export function CandlestickChart({ onTimeframeChange, onTradeSetupChange, fundingRate = 0 }: CandlestickChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const priceLinesRef = useRef<IPriceLine[]>([]);
    const setupLinesRef = useRef<IPriceLine[]>([]);
    const rawCandlesRef = useRef<Candle[]>([]);
    const liveCandleRef = useRef<CandlestickData<Time> | null>(null);
    const liquidityPrimitiveRef = useRef<LiquidityZonesPrimitive | null>(null);
    const obPrimitiveRef = useRef<OrderBlockPrimitive | null>(null);
    const fvgPrimitiveRef = useRef<FvgPrimitive | null>(null);
    const volProfilePrimitiveRef = useRef<VolumeProfilePrimitive | null>(null);
    const liquidityZonesRef = useRef<LiquidityZone[]>([]);
    const [timeframe, setTimeframe] = useState<Timeframe>("1h");
    const [loading, setLoading] = useState(false);
    const [cvdData, setCvdData] = useState<CvdPoint[]>([]);

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

        // Attach liquidity zones primitive
        const liquidityPrimitive = new LiquidityZonesPrimitive();
        series.attachPrimitive(liquidityPrimitive);
        liquidityPrimitiveRef.current = liquidityPrimitive;

        // Attach order block primitive
        const obPrimitive = new OrderBlockPrimitive();
        series.attachPrimitive(obPrimitive);
        obPrimitiveRef.current = obPrimitive;

        // Attach fair value gap primitive
        const fvgPrimitive = new FvgPrimitive();
        series.attachPrimitive(fvgPrimitive);
        fvgPrimitiveRef.current = fvgPrimitive;

        // Attach volume profile primitive
        const volProfilePrimitive = new VolumeProfilePrimitive();
        series.attachPrimitive(volProfilePrimitive);
        volProfilePrimitiveRef.current = volProfilePrimitive;

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
            priceLinesRef.current = [];
        };
    }, []);

    // Remove all price lines
    const clearPriceLines = useCallback(() => {
        const candleSeries = seriesRef.current;
        if (!candleSeries) return;
        for (const pl of priceLinesRef.current) {
            candleSeries.removePriceLine(pl);
        }
        priceLinesRef.current = [];
    }, []);

    // Remove trade setup overlay lines
    const clearSetupLines = useCallback(() => {
        const candleSeries = seriesRef.current;
        if (!candleSeries) return;
        for (const pl of setupLinesRef.current) {
            candleSeries.removePriceLine(pl);
        }
        setupLinesRef.current = [];
    }, []);

    // Render indicator overlays from raw candle data
    const renderOverlays = useCallback((candles: Candle[]) => {
        const candleSeries = seriesRef.current;
        if (!candleSeries || candles.length === 0) return;

        clearPriceLines();
        clearSetupLines();

        const indCandles = candles.map(apiCandleToIndicator);

        // Key Levels — PDH/PDL
        let keyLevels: { pdh: number; pdl: number } | null = null;
        if (indicatorConfig.keyLevels) {
            const levels = prevDayHighLow(indCandles);
            if (levels) {
                keyLevels = levels;
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

        // Liquidity zones visibility
        if (!indicatorConfig.liquidityZones) {
            liquidityPrimitiveRef.current?.setZones([]);
        }

        // Order Blocks
        let orderBlocks: OrderBlock[] = [];
        if (indicatorConfig.orderBlocks) {
            orderBlocks = detectOrderBlocks(indCandles);
            obPrimitiveRef.current?.setBlocks(orderBlocks);
        } else {
            obPrimitiveRef.current?.setBlocks([]);
        }

        // Fair Value Gaps
        let fvgs: FairValueGap[] = [];
        if (indicatorConfig.fvg) {
            fvgs = detectFairValueGaps(indCandles);
            fvgPrimitiveRef.current?.setGaps(fvgs);
        } else {
            fvgPrimitiveRef.current?.setGaps([]);
        }

        // CVD
        let cvdPoints: CvdPoint[] = [];
        if (indicatorConfig.cvd) {
            cvdPoints = computeCVD(candles);
            setCvdData(cvdPoints);
        } else {
            setCvdData([]);
        }

        // Volume Profile
        if (indicatorConfig.volumeProfile) {
            const profile = computeVolumeProfile(candles);
            volProfilePrimitiveRef.current?.setData(profile);
        } else {
            volProfilePrimitiveRef.current?.setData(null);
        }

        // Trade Setup — confluence engine
        if (indicatorConfig.tradeSetup) {
            const lastCandle = candles[candles.length - 1];
            const currentPrice = lastCandle ? parseFloat(lastCandle.close) : 0;
            const cvdDivergences = detectCvdDivergence(candles, cvdPoints);

            const setup = computeTradeSetup({
                candles,
                orderBlocks,
                fvgs,
                cvdDivergences,
                liquidityZones: liquidityZonesRef.current,
                keyLevels,
                fundingRate,
                currentPrice,
            });

            onTradeSetupChange?.(setup);

            // Draw overlay lines on chart
            if (setup && candleSeries) {
                const isLong = setup.direction === "long";

                // Entry zone — two lines forming a band
                const entryLowLine = candleSeries.createPriceLine({
                    price: setup.entryZone.low,
                    color: isLong ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
                    lineWidth: 1,
                    lineStyle: LineStyle.Dotted,
                    axisLabelVisible: false,
                    title: "",
                });
                const entryHighLine = candleSeries.createPriceLine({
                    price: setup.entryZone.high,
                    color: isLong ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
                    lineWidth: 1,
                    lineStyle: LineStyle.Dotted,
                    axisLabelVisible: false,
                    title: "Entry",
                });

                // Stop Loss
                const slLine = candleSeries.createPriceLine({
                    price: setup.stopLoss,
                    color: "#ef4444",
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: "SL",
                });

                // TP1
                const tp1Line = candleSeries.createPriceLine({
                    price: setup.tp1,
                    color: "#3b82f6",
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: "TP1",
                });

                setupLinesRef.current.push(entryLowLine, entryHighLine, slLine, tp1Line);

                // TP2
                if (setup.tp2 != null) {
                    const tp2Line = candleSeries.createPriceLine({
                        price: setup.tp2,
                        color: "rgba(59,130,246,0.6)",
                        lineWidth: 1,
                        lineStyle: LineStyle.Dashed,
                        axisLabelVisible: true,
                        title: "TP2",
                    });
                    setupLinesRef.current.push(tp2Line);
                }

                // TP3
                if (setup.tp3 != null) {
                    const tp3Line = candleSeries.createPriceLine({
                        price: setup.tp3,
                        color: "rgba(59,130,246,0.4)",
                        lineWidth: 1,
                        lineStyle: LineStyle.Dashed,
                        axisLabelVisible: true,
                        title: "TP3",
                    });
                    setupLinesRef.current.push(tp3Line);
                }
            }
        } else {
            onTradeSetupChange?.(null);
        }
    }, [indicatorConfig, clearPriceLines, clearSetupLines, fundingRate, onTradeSetupChange]);

    // Fetch candles when pair or timeframe changes
    const fetchCandles = useCallback(async () => {
        if (!selectedPairId || !seriesRef.current) return;

        setLoading(true);
        try {
            const candleRes = await getCandles(selectedPairId, { timeframe, limit: 300 });

            rawCandlesRef.current = candleRes.data.candles;
            liveCandleRef.current = null;
            const lwData = candleRes.data.candles.map(candleToLW);
            seriesRef.current.setData(lwData);

            renderOverlays(candleRes.data.candles);

            chartRef.current?.timeScale().fitContent();
        } catch {
            // Non-fatal — chart shows empty
        } finally {
            setLoading(false);
        }
    }, [selectedPairId, timeframe, renderOverlays]);

    useEffect(() => {
        fetchCandles();
    }, [fetchCandles]);

    // Re-render overlays when indicator config changes
    useEffect(() => {
        if (rawCandlesRef.current.length > 0) {
            renderOverlays(rawCandlesRef.current);
        }
    }, [renderOverlays]);

    // Live update: price.tick → update current candle
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
                live.high = Math.max(live.high, price);
                live.low = Math.min(live.low, price);
                live.close = price;
            } else {
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

    // Live update: candle.closed → append completed candle
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

            liveCandleRef.current = null;

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
                liquidityZonesRef.current = data.zones;
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
            </div>

            {/* CVD sub-panel */}
            {indicatorConfig.cvd && cvdData.length > 0 && (
                <CvdPanel cvdData={cvdData} mainChart={chartRef.current} />
            )}
        </div>
    );
}
