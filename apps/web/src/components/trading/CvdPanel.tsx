import { useEffect, useRef } from "react";
import {
    createChart,
    LineSeries,
    type IChartApi,
    type ISeriesApi,
    type Time,
    ColorType,
} from "lightweight-charts";
import type { CvdPoint } from "@/lib/cvd";

interface CvdPanelProps {
    cvdData: CvdPoint[];
    mainChart: IChartApi | null;
}

export function CvdPanel({ cvdData, mainChart }: CvdPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

    // Create CVD chart instance
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: "#0a0a0a" },
                textColor: "#6b7280",
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { color: "#1f2937", style: 1 },
            },
            crosshair: {
                vertLine: { color: "#4b5563", labelBackgroundColor: "#374151" },
                horzLine: { color: "#4b5563", labelBackgroundColor: "#374151" },
            },
            timeScale: {
                borderColor: "#1f2937",
                timeVisible: true,
                secondsVisible: false,
                visible: false, // hide time axis — synced with main chart
            },
            rightPriceScale: {
                borderColor: "#1f2937",
            },
            height: 80,
        });

        const series = chart.addSeries(LineSeries, {
            color: "#06b6d4",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: true,
        });

        // Zero line
        series.createPriceLine({
            price: 0,
            color: "#374151",
            lineWidth: 1,
            lineStyle: 2, // Dashed
            axisLabelVisible: false,
            title: "",
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Responsive resize
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width } = entry.contentRect;
                chart.applyOptions({ width });
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

        const mainTimeScale = mainChart.timeScale();
        const cvdTimeScale = chartRef.current.timeScale();

        const handler = () => {
            const range = mainTimeScale.getVisibleLogicalRange();
            if (range) {
                cvdTimeScale.setVisibleLogicalRange(range);
            }
        };

        mainTimeScale.subscribeVisibleLogicalRangeChange(handler);
        // Initial sync
        handler();

        return () => {
            mainTimeScale.unsubscribeVisibleLogicalRangeChange(handler);
        };
    }, [mainChart]);

    // Update data
    useEffect(() => {
        if (!seriesRef.current || cvdData.length === 0) return;

        const lwData = cvdData.map((p) => ({
            time: p.time as Time,
            value: p.value,
        }));
        seriesRef.current.setData(lwData);
    }, [cvdData]);

    return (
        <div className="border-t border-gray-800">
            <div className="flex items-center px-2 py-0.5">
                <span className="text-[10px] text-gray-500 uppercase tracking-widest">CVD</span>
            </div>
            <div ref={containerRef} style={{ height: 80 }} />
        </div>
    );
}
