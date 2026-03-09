import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    HistogramSeries,
    type IChartApi,
    type ISeriesApi,
    type Time,
    ColorType,
} from "lightweight-charts";
import { getConfidenceHeatmap, type ConfidenceBar } from "@/api/endpoints/signals";
import type { Timeframe } from "@/api/endpoints/candles";

interface ConfidenceHeatmapProps {
    pairId: string;
    timeframe: Timeframe;
    mainChart: IChartApi | null;
}

function barColor(direction: string, confidence: number): string {
    const alpha = Math.max(0.1, confidence / 100);
    if (direction === "BUY") return `rgba(34, 197, 94, ${alpha})`;
    if (direction === "SELL") return `rgba(239, 68, 68, ${alpha})`;
    return "rgba(107, 114, 128, 0.1)";
}

export function ConfidenceHeatmap({ pairId, timeframe, mainChart }: ConfidenceHeatmapProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [tooltip, setTooltip] = useState<{
        x: number;
        direction: string;
        confidence: number;
        time: string;
    } | null>(null);

    // Create heatmap chart
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: "#0a0a0a" },
                textColor: "#9ca3af",
            },
            grid: { vertLines: { visible: false }, horzLines: { visible: false } },
            timeScale: { visible: false },
            rightPriceScale: { visible: false },
            height: 40,
            crosshair: {
                vertLine: { visible: true, color: "#4b556340", labelVisible: false },
                horzLine: { visible: false },
            },
        });

        const series = chart.addSeries(HistogramSeries, {
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: { type: "volume" },
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Tooltip on crosshair move
        chart.subscribeCrosshairMove((param) => {
            if (!param.time || param.seriesData.size === 0) {
                setTooltip(null);
                return;
            }
            const data = param.seriesData.get(series);
            if (!data || !("value" in data)) {
                setTooltip(null);
                return;
            }

            const bar = data as { value: number; color?: string; time: Time };
            // Determine direction from color
            const color = bar.color ?? "";
            let direction = "NEUTRAL";
            if (color.includes("34, 197, 94")) direction = "BUY";
            else if (color.includes("239, 68, 68")) direction = "SELL";

            const t = typeof param.time === "number"
                ? new Date(param.time * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
                : String(param.time);

            const point = param.point;
            setTooltip({
                x: point?.x ?? 0,
                direction,
                confidence: Math.round(bar.value),
                time: t,
            });
        });

        // Responsive resize (width only, height is fixed)
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                chart.applyOptions({ width: entry.contentRect.width });
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

    // Sync time scale with main chart
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const heatmapChart = chartRef.current;

        const handler = (range: { from: number; to: number } | null) => {
            if (range) {
                heatmapChart.timeScale().setVisibleLogicalRange(range);
            }
        };
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);

        return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }, [mainChart]);

    // Fetch heatmap data
    const fetchData = useCallback(async () => {
        if (!pairId || !seriesRef.current) return;

        try {
            const { data } = await getConfidenceHeatmap(pairId, { timeframe, limit: 300 });
            const histogramData = data.bars.map((b: ConfidenceBar) => ({
                time: b.ts as Time,
                value: b.confidence,
                color: barColor(b.direction, b.confidence),
            }));
            seriesRef.current.setData(histogramData);
        } catch {
            // Non-fatal
        }
    }, [pairId, timeframe]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Listen for new signals to refetch
    useEffect(() => {
        if (!pairId) return;

        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId === pairId) fetchData();
        };

        window.addEventListener("sse:signal.new", handler);
        return () => window.removeEventListener("sse:signal.new", handler);
    }, [pairId, fetchData]);

    return (
        <div className="relative">
            <div ref={containerRef} className="w-full" style={{ height: 40 }} />
            {tooltip && tooltip.confidence > 0 && (
                <div
                    className="absolute bottom-full mb-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-300 whitespace-nowrap z-20 pointer-events-none"
                    style={{ left: Math.max(0, tooltip.x - 60) }}
                >
                    <span className={tooltip.direction === "BUY" ? "text-green-400" : tooltip.direction === "SELL" ? "text-red-400" : "text-gray-400"}>
                        {tooltip.direction}
                    </span>
                    {" "}{tooltip.confidence}% confidence
                    <div className="text-gray-500">{tooltip.time}</div>
                </div>
            )}
        </div>
    );
}
