import { useEffect, useRef, useState } from "react";
import {
    createChart,
    LineSeries,
    LineStyle,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import type { ADXResult } from "@/lib/indicators";
import type { AdxParams } from "@/lib/chartLayouts/catalog";
import { usePanelCrosshairHover } from "@/hooks/usePanelCrosshairHover";
import { SubPanelHeader } from "./SubPanelHeader";
import { usePaneCollapsed } from "@/stores/chartLayoutStore";

export const ADX_COLOR = "#e5e7eb";
export const PLUS_DI_COLOR = "#22c55e";
export const MINUS_DI_COLOR = "#ef4444";

interface ADXPanelProps {
    data: ADXResult;
    params: AdxParams;
    mainChart: IChartApi | null;
    height?: number;
}

type Values = { adx: number | null; plus: number | null; minus: number | null };

const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(2));

/**
 * ADX + DI+ / DI− (TradingView's built-in ADX/DMI, Wilder) with the threshold
 * line. The DI lines start at bar `diLength` and ADX later, so the pane
 * syncs to the price chart by TIME, not bar index.
 */
export function ADXPanel({ data, params, mainChart, height: externalHeight }: ADXPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const adxRef = useRef<ISeriesApi<"Line"> | null>(null);
    const plusRef = useRef<ISeriesApi<"Line"> | null>(null);
    const minusRef = useRef<ISeriesApi<"Line"> | null>(null);
    const thresholdRef = useRef<IPriceLine | null>(null);
    const [collapsed, setCollapsed] = usePaneCollapsed("adx");
    const [hovered, setHovered] = useState<Values | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const chart = createChart(containerRef.current, {
            height: 100,
            layout: { background: { color: "#0a0a0a" }, textColor: "#555", fontSize: 9 },
            grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: {
                vertLine: { visible: true, color: "rgba(255,255,255,0.2)", width: 1, labelVisible: false },
                horzLine: { visible: false },
            },
        });
        const opts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false } as const;
        plusRef.current = chart.addSeries(LineSeries, { ...opts, color: PLUS_DI_COLOR });
        minusRef.current = chart.addSeries(LineSeries, { ...opts, color: MINUS_DI_COLOR });
        adxRef.current = chart.addSeries(LineSeries, { ...opts, color: ADX_COLOR, lineWidth: 2 });
        chartRef.current = chart;
        return () => {
            chart.remove();
            chartRef.current = null; adxRef.current = null; plusRef.current = null; minusRef.current = null; thresholdRef.current = null;
        };
    }, []);

    // Threshold line (editable).
    useEffect(() => {
        const s = adxRef.current;
        if (!s) return;
        if (thresholdRef.current) s.removePriceLine(thresholdRef.current);
        thresholdRef.current = s.createPriceLine({
            price: params.threshold, color: "rgba(255,255,255,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed,
            axisLabelVisible: true, title: "",
        });
    }, [params.threshold]);

    useEffect(() => {
        if (!mainChart || !chartRef.current) return;
        const sub = chartRef.current;
        // Guard the empty-chart race ("Value is null" before the series has data).
        const handler = (range: unknown) => { if (!range || data.plusDI.length === 0) return; sub.timeScale().setVisibleRange(range as never); };
        mainChart.timeScale().subscribeVisibleTimeRangeChange(handler);
        return () => mainChart.timeScale().unsubscribeVisibleTimeRangeChange(handler);
    }, [mainChart, data.plusDI.length]);

    useEffect(() => {
        if (chartRef.current && !collapsed && externalHeight) chartRef.current.applyOptions({ height: externalHeight });
    }, [externalHeight, collapsed]);

    useEffect(() => {
        if (!adxRef.current || !plusRef.current || !minusRef.current || data.plusDI.length === 0) return;
        const line = (pts: { time: number; value: number }[]) => pts.map((p) => ({ time: p.time as Time, value: p.value }));
        plusRef.current.setData(line(data.plusDI));
        minusRef.current.setData(line(data.minusDI));
        adxRef.current.setData(line(data.adx));
        if (mainChart && chartRef.current) {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleRange(range); });
        }
    }, [data, mainChart]);

    // Re-sync when the pane expands from collapsed.
    useEffect(() => {
        if (collapsed || !mainChart || !chartRef.current) return;
        requestAnimationFrame(() => {
            const range = mainChart.timeScale().getVisibleRange();
            if (range) chartRef.current?.timeScale().setVisibleRange(range);
        });
    }, [collapsed, mainChart]);

    // Hover readout (exact time match; ADX may be missing where DI exists).
    usePanelCrosshairHover<Values>({
        mainChart,
        getChart: () => chartRef.current,
        getSeries: () => plusRef.current,
        lookup: (t) => {
            const at = (pts: { time: number; value: number }[]) => pts.find((p) => p.time === t)?.value ?? null;
            const plus = at(data.plusDI);
            if (plus == null) return null;
            return { value: { adx: at(data.adx), plus, minus: at(data.minusDI) }, price: plus };
        },
        setHovered,
        deps: [data],
    });

    const last = (pts: { value: number }[]) => (pts.length > 0 ? pts[pts.length - 1]!.value : null);
    const shown: Values = hovered ?? { adx: last(data.adx), plus: last(data.plusDI), minus: last(data.minusDI) };

    return (
        <div data-testid="adx-panel">
            <SubPanelHeader
                collapsed={collapsed}
                onToggle={() => setCollapsed((v) => !v)}
                label={`ADX ${params.diLength}/${params.adxSmoothing}`}
                rightContent={<>
                    <span style={{ color: ADX_COLOR }}>ADX {fmt(shown.adx)}</span>{" "}
                    <span style={{ color: PLUS_DI_COLOR }}>+DI {fmt(shown.plus)}</span>{" "}
                    <span style={{ color: MINUS_DI_COLOR }}>−DI {fmt(shown.minus)}</span>
                </>}
            />
            <div ref={containerRef} style={{ height: collapsed ? 0 : (externalHeight ?? 100), overflow: "hidden" }} />
        </div>
    );
}
