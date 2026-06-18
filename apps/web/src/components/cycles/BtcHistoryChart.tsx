import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  PriceScaleMode,
  LineStyle,
  CrosshairMode,
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

// Even decades spanning the data ($0.05–$126K) — perfectly even on a log scale, all
// inside the pinned range so every one renders. Drawn as a clip-proof HTML axis overlay
// (lightweight-charts paints its own axis in-canvas, where scaleMargins clips the top label).
const PRICE_TICKS = [0.1, 1, 10, 100, 1000, 10000, 100000];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Full-precision price for the floating tooltip (axis stays compact $K). */
function tipPrice(v: number): string {
  return v >= 1 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
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
  const tooltipRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);

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
        // Horizontal gridlines drawn by the HTML axis overlay so they match our labels.
        horzLines: { visible: false },
      },
      rightPriceScale: {
        // Kept visible so log mode + autoscale stay active (visible:false reverts the scale to
        // linear). Its canvas auto-labels are masked by the HTML axis overlay's opaque gutter cover.
        visible: true,
        borderVisible: false,
        mode: PriceScaleMode.Logarithmic,
        scaleMargins: { top: 0.04, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "rgba(0,255,65,0.18)",
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 8,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(0,255,65,0.20)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#0d1a0d" },
        horzLine: { color: "rgba(0,255,65,0.20)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#0d1a0d" },
      },
    });

    const series = chart.addSeries(LineSeries, {
      color: GREEN,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      // Pin the range just above the ~$116K monthly-close max (ATH $126K) so log autoscale can't
      // overshoot; the top auto-label lands ~$360K (with the $100K reference line + $40K tick below
      // it) rather than a far-overshoot $900K. Bump maxValue if the monthly-close series exceeds ~$126K.
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0.05, maxValue: 130000 } }),
    });
    series.setData(LINE_DATA);

    const markers = createSeriesMarkers(series, sortMarkers(STATIC_MARKERS));
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;

    // HTML price axis (even decades) — clip-proof labels + faint gridlines positioned via
    // priceToCoordinate. The canvas price scale stays VISIBLE (hiding it disables log mode +
    // autoscale), so we mask its auto-labels with an opaque cover over the scale's gutter and
    // draw our own clean decade labels on top. Re-run on resize (pane height changes the mapping).
    const renderAxis = () => {
      const s = seriesRef.current;
      const chartApi = chartRef.current;
      const axis = axisRef.current;
      if (!s || !chartApi || !axis) return;
      const gutter = chartApi.priceScale("right").width();
      axis.innerHTML = "";
      // Opaque strip covering lightweight-charts' own (clipped/auto) price labels.
      const cover = document.createElement("div");
      cover.style.cssText = `position:absolute;top:0;bottom:0;right:0;width:${gutter}px;background:#040404;`;
      axis.appendChild(cover);
      for (const tick of PRICE_TICKS) {
        const y = s.priceToCoordinate(tick);
        if (y == null) continue;
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;left:0;right:${gutter}px;top:${y}px;height:1px;background:rgba(0,255,65,0.05);`;
        axis.appendChild(line);
        const label = document.createElement("div");
        label.className = "text-[10px] font-mono text-white/45";
        label.style.cssText = `position:absolute;right:0;width:${gutter}px;top:${y}px;transform:translateY(-50%);text-align:right;padding-right:6px;`;
        label.textContent = axisPrice(tick);
        axis.appendChild(label);
      }
    };
    renderAxis();

    // Floating combined tooltip ("Mon YYYY · $X close") that tracks the cursor.
    // chart.remove() on unmount tears the subscription down — no manual unsubscribe.
    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tip.style.display = "none";
        return;
      }
      const d = param.seriesData.get(series) as { value?: number } | undefined;
      const value = d?.value;
      if (value === undefined) {
        tip.style.display = "none";
        return;
      }
      const [yr, mo] = String(param.time).split("-");
      const label = `${MONTHS[Number(mo) - 1]} ${yr}`;
      tip.textContent = `${label} · ${tipPrice(value)} close`;
      tip.style.display = "block";
      const w = containerRef.current?.clientWidth ?? 0;
      const clampedX = Math.max(48, Math.min(param.point.x, w - 48));
      tip.style.left = `${clampedX}px`;
    });

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
      // priceToCoordinate depends on pane height — re-place the HTML axis on resize.
      renderAxis();
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
      <style>{`
        @keyframes cyclesReveal { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
        .cycles-chart-reveal { animation: cyclesReveal 700ms ease-out both; }
      `}</style>
      <div className="relative">
        <div ref={containerRef} className="w-full h-[340px] cycles-chart-reveal" />
        {/* HTML price axis overlay (gridlines + labels) — clip-proof; pointer-events:none
            so the crosshair/tooltip below still receive mouse events. */}
        <div
          ref={axisRef}
          className="pointer-events-none absolute inset-0"
          style={{ overflow: "visible" }}
        />
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-sm border border-tradr-green/30 bg-[#0a0f0a]/95 px-2 py-1 text-[10px] font-mono text-white/85"
          style={{ display: "none", top: 8, left: 0 }}
        />
      </div>
      <div className="mt-1.5 text-[9px] text-white/25 tracking-[1px] font-mono leading-4">
        Line = monthly closes; cycle-top / ATH markers are intraday wicks, so they sit
        above the line — expected, not a data error.
      </div>
    </div>
  );
}
