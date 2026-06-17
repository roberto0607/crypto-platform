import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type LineData,
} from "lightweight-charts";
import { BTC_MONTHLY_CLOSE, BTC_CYCLES, BTC_HALVINGS, BTC_ATH } from "@/lib/btcCycles";

// ── Full-history BTC monthly-close line (log scale) with cycle markers ──
// Mirrors the v5 lightweight-charts patterns in components/trading/CandlestickChart.tsx:
// createChart → addSeries(LineSeries) → createSeriesMarkers, ResizeObserver width,
// chart.remove() cleanup. The only live input is currentPrice (BTC); it draws the
// line into the ongoing month and positions the "you are here" marker.

const GREEN = "#00ff41";
const RED = "#ff3b3b";
const AMBER = "#b8860b";
const DIM_GREEN = "rgba(0,255,65,0.55)";

/** Snap any ISO date to its month bucket so markers align with the monthly line. */
function monthBucket(iso: string): Time {
  return `${iso.slice(0, 7)}-01` as Time;
}

/** 69000 → "$69K", 15500 → "$15.5K", 164 → "$164". */
function compactK(v: number): string {
  if (v >= 1000) {
    const s = (v / 1000).toFixed(1).replace(/\.0$/, "");
    return `$${s}K`;
  }
  return `$${Math.round(v)}`;
}

/** Price-axis tick formatter: $100K / $1K / $100 / $0.10 — no cents on big numbers. */
function axisPrice(v: number): string {
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  if (v >= 1) return `$${Math.round(v)}`;
  return `$${v.toFixed(2)}`;
}

const LINE_DATA: LineData<Time>[] = BTC_MONTHLY_CLOSE.map(([ym, v]) => ({
  time: `${ym}-01` as Time,
  value: v,
}));
const LAST = BTC_MONTHLY_CLOSE[BTC_MONTHLY_CLOSE.length - 1]!;
const LAST_TIME = `${LAST[0]}-01` as Time;
const LAST_CLOSE = LAST[1];

// Static markers: halvings (H1–H4), cycle tops, cycle bottoms. The live
// "you are here" marker is appended per-tick in the price effect below.
const STATIC_MARKERS: SeriesMarker<Time>[] = [
  ...BTC_HALVINGS.map((h, i) => ({
    time: monthBucket(h.date),
    position: "belowBar" as const,
    shape: "square" as const,
    color: AMBER,
    text: `H${i + 1}`,
  })),
  ...BTC_CYCLES.map((c) => ({
    time: monthBucket(c.topDate),
    position: "aboveBar" as const,
    shape: "arrowDown" as const,
    color: RED,
    text: `▼${Math.abs(c.drawdownPct)}%`,
  })),
  ...BTC_CYCLES.map((c) => ({
    time: monthBucket(c.bottomDate),
    position: "belowBar" as const,
    shape: "arrowUp" as const,
    color: DIM_GREEN,
    text: compactK(c.bottomPrice),
  })),
];

/** lightweight-charts requires markers sorted ascending by time; ISO sorts chronologically. */
function sortMarkers(m: SeriesMarker<Time>[]): SeriesMarker<Time>[] {
  return [...m].sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

interface Props {
  currentPrice?: number;
}

export default function BtcHistoryChart({ currentPrice }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Mount once: build chart + static line + static markers + resize observer.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
        textColor: "rgba(255,255,255,0.45)",
        attributionLogo: false,
      },
      localization: { priceFormatter: axisPrice },
      grid: {
        vertLines: { color: "rgba(0,255,65,0.05)" },
        horzLines: { color: "rgba(0,255,65,0.05)" },
      },
      rightPriceScale: {
        borderColor: "rgba(0,255,65,0.18)",
        mode: PriceScaleMode.Logarithmic,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "rgba(0,255,65,0.18)",
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 8,
      },
      crosshair: {
        vertLine: { color: "rgba(0,255,65,0.16)", labelBackgroundColor: "#0d1a0d" },
        horzLine: { color: "rgba(0,255,65,0.16)", labelBackgroundColor: "#0d1a0d" },
      },
    });

    const series = chart.addSeries(LineSeries, {
      color: GREEN,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      // Pin the range (data spans 0.06 → ~116K) so log autoscale can't overshoot
      // to millions and squash the line. Bump maxValue if BTC prints above ~$180K.
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0.05, maxValue: 200000 } }),
    });
    series.setData(LINE_DATA);

    const markers = createSeriesMarkers(series, sortMarkers(STATIC_MARKERS));
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Live: extend the line into the current month + place the "you are here" marker.
  // Falls back to the last monthly close when no live price is available.
  useEffect(() => {
    const series = seriesRef.current;
    const markers = markersRef.current;
    if (!series || !markers) return;

    let nowTime: Time = LAST_TIME;
    let nowValue = LAST_CLOSE;
    if (currentPrice !== undefined && Number.isFinite(currentPrice)) {
      const now = new Date();
      nowTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01` as Time;
      nowValue = currentPrice;
      series.update({ time: nowTime, value: currentPrice });
    }

    const pct = Math.round(((nowValue - BTC_ATH.price) / BTC_ATH.price) * 100);
    const nowMarker: SeriesMarker<Time> = {
      time: nowTime,
      position: "aboveBar",
      shape: "circle",
      color: "#ffffff",
      text: `NOW ${pct}%`,
    };
    markers.setMarkers(sortMarkers([...STATIC_MARKERS, nowMarker]));
  }, [currentPrice]);

  return (
    <div>
      <div ref={containerRef} className="w-full h-[340px]" />
      <div className="mt-1.5 text-[9px] text-white/25 tracking-[1px] font-mono leading-4">
        Line = monthly closes; cycle-top / ATH markers are intraday wicks, so they sit
        above the line — expected, not a data error.
      </div>
    </div>
  );
}
