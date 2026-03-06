import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    CandlestickSeries,
    type IChartApi,
    type ISeriesApi,
    type CandlestickData,
    type Time,
    ColorType,
} from "lightweight-charts";
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { useTradingStore } from "@/stores/tradingStore";

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

export function CandlestickChart() {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const [timeframe, setTimeframe] = useState<Timeframe>("1h");
    const [loading, setLoading] = useState(false);

    const selectedPairId = useTradingStore((s) => s.selectedPairId);

    // Create chart instance
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: "#0a0a0a" },
                textColor: "#9ca3af",
            },
            grid: {
                vertLines: { color: "#1f2937" },
                horzLines: { color: "#1f2937" },
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
        };
    }, []);

    // Fetch candles when pair or timeframe changes
    const fetchCandles = useCallback(async () => {
        if (!selectedPairId || !seriesRef.current) return;

        setLoading(true);
        try {
            const { data } = await getCandles(selectedPairId, {
                timeframe,
                limit: 300,
            });

            const lwData = data.candles.map(candleToLW);
            seriesRef.current.setData(lwData);

            // Fit content to show all candles
            chartRef.current?.timeScale().fitContent();
        } catch {
            // Non-fatal — chart shows empty
        } finally {
            setLoading(false);
        }
    }, [selectedPairId, timeframe]);

    useEffect(() => {
        fetchCandles();
    }, [fetchCandles]);

    // Live update: price.tick → update current candle
    useEffect(() => {
        if (!selectedPairId) return;

        const handlePriceTick = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId || !seriesRef.current) return;

            const price = parseFloat(detail.last);
            const now = Math.floor(Date.now() / 1000) as Time;

            // Update the last candle with the new price
            seriesRef.current.update({
                time: now,
                open: price,
                high: price,
                low: price,
                close: price,
            });
        };

        window.addEventListener("sse:price.tick", handlePriceTick);
        return () => window.removeEventListener("sse:price.tick", handlePriceTick);
    }, [selectedPairId]);

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
        };

        window.addEventListener("sse:candle.closed", handleCandleClosed);
        return () => window.removeEventListener("sse:candle.closed", handleCandleClosed);
    }, [selectedPairId, timeframe]);

    return (
        <div className="flex flex-col h-full">
            {/* Timeframe selector */}
            <div className="flex items-center gap-1 mb-2">
                {TIMEFRAMES.map((tf) => (
                    <button
                        key={tf}
                        onClick={() => setTimeframe(tf)}
                        className={`px-2 py-1 text-xs rounded transition-colors ${
                            timeframe === tf
                                ? "bg-blue-600 text-white"
                                : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                        }`}
                    >
                        {tf}
                    </button>
                ))}
                {loading && (
                    <span className="text-gray-600 text-xs ml-2">Loading...</span>
                )}
            </div>

            {/* Chart container */}
            <div ref={containerRef} className="flex-1 min-h-0" />
        </div>
    );
}
