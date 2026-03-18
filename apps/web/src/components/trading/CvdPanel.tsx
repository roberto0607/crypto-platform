import { useEffect, useRef, useMemo } from "react";
import {
    createChart,
    AreaSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { CvdPoint, CvdDivergence, CvdDataSource } from "@/lib/cvd";

interface CvdPanelProps {
    cvdData: CvdPoint[];
    divergences: CvdDivergence[];
    dataSource: CvdDataSource;
    mainChart: IChartApi | null;
}

function formatCvdValue(val: number): string {
    const abs = Math.abs(val);
    if (abs >= 1_000_000) return (val > 0 ? "+" : "") + (val / 1_000_000).toFixed(1) + "M";
    if (abs >= 1_000) return (val > 0 ? "+" : "") + (val / 1_000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (val > 0 ? "+" : "") + val.toFixed(0);
}

export function CvdPanel({ cvdData, divergences: _divergences, dataSource, mainChart }: CvdPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const posSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
    const negSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);

    const lastValue = cvdData.length > 0 ? cvdData[cvdData.length - 1]!.value : 0;

    const badgeInfo = useMemo(() => {
        if (dataSource === "REAL") return { label: "LIVE", dot: true, color: "rgba(0,230,118,0.7)" };
        if (dataSource === "MIXED") return { label: "~LIVE", dot: false, color: "rgba(255,200,0,0.7)" };
        return { label: "EST", dot: false, color: "rgba(255,255,255,0.25)" };
    }, [dataSource]);

    // Create chart instance
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: "transparent" },
                textColor: "rgba(255,255,255,0.3)",
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { color: "rgba(255,255,255,0.03)" },
            },
            rightPriceScale: { visible: false },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: false },
                horzLine: { visible: false },
            },
            height: 60,
        });

        const posSeries = chart.addSeries(AreaSeries, {
            lineColor: "#00e676",
            topColor: "rgba(0,230,118,0.15)",
            bottomColor: "rgba(0,230,118,0.02)",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });

        const negSeries = chart.addSeries(AreaSeries, {
            lineColor: "#ff3c3c",
            topColor: "rgba(255,60,60,0.02)",
            bottomColor: "rgba(255,60,60,0.15)",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });

        // Zero reference line on positive series
        posSeries.createPriceLine({
            price: 0,
            color: "rgba(255,255,255,0.1)",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: "",
        });

        chartRef.current = chart;
        posSeriesRef.current = posSeries;
        negSeriesRef.current = negSeries;

        // Responsive resize
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
            posSeriesRef.current = null;
            negSeriesRef.current = null;
        };
    }, []);

    // Sync time scale with main chart
    useEffect(() => {
        if (!mainChart || !chartRef.current) return;

        const mainTimeScale = mainChart.timeScale();
        const cvdTimeScale = chartRef.current.timeScale();

        const handler = () => {
            const range = mainTimeScale.getVisibleLogicalRange();
            if (range) cvdTimeScale.setVisibleLogicalRange(range);
        };

        mainTimeScale.subscribeVisibleLogicalRangeChange(handler);
        handler();

        return () => {
            mainTimeScale.unsubscribeVisibleLogicalRangeChange(handler);
        };
    }, [mainChart]);

    // Update data — split into positive/negative series
    useEffect(() => {
        if (!posSeriesRef.current || !negSeriesRef.current || cvdData.length === 0) return;

        const posData: { time: Time; value: number }[] = [];
        const negData: { time: Time; value: number }[] = [];

        for (const p of cvdData) {
            const t = p.time as Time;
            if (p.value >= 0) {
                posData.push({ time: t, value: p.value });
                negData.push({ time: t, value: 0 });
            } else {
                posData.push({ time: t, value: 0 });
                negData.push({ time: t, value: p.value });
            }
        }

        posSeriesRef.current.setData(posData);
        negSeriesRef.current.setData(negData);
    }, [cvdData]);

    return (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(6,10,16,0.95)" }}>
            {/* Header bar — 20px */}
            <div style={{ height: 20, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px", position: "relative", zIndex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "Oxanium, monospace", fontSize: 9, color: "rgba(255,255,255,0.5)", letterSpacing: 2, textTransform: "uppercase" }}>
                        CVD
                    </span>
                    <span style={{
                        fontFamily: "Oxanium, monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        color: lastValue >= 0 ? "#00e676" : "#ff3c3c",
                    }}>
                        {formatCvdValue(lastValue)}
                    </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    {badgeInfo.dot && (
                        <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#00e676", display: "inline-block" }} />
                    )}
                    <span style={{ fontFamily: "Oxanium, monospace", fontSize: 7, letterSpacing: 1.5, color: badgeInfo.color, textTransform: "uppercase" }}>
                        {badgeInfo.label}
                    </span>
                </div>
            </div>
            {/* Chart area — 60px */}
            <div ref={containerRef} style={{ height: 60 }} />
        </div>
    );
}
