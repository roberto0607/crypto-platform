import { useState, useEffect, useRef, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  ColorType,
} from "lightweight-charts";
import {
  start as startReplay,
  pause as pauseReplay,
  resume as resumeReplay,
  seek as seekReplay,
  stop as stopReplay,
  getActive as getActiveReplay,
} from "@/api/endpoints/replay";
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { placeOrder, listOrders } from "@/api/endpoints/trading";
import { getPositions } from "@/api/endpoints/analytics";
import { listWallets } from "@/api/endpoints/wallets";
import { useAppStore } from "@/stores/appStore";
import { normalizeApiError } from "@/lib/errors";
import type { ReplaySession, Position, UUID } from "@/types/api";
import type { AxiosError } from "axios";

/* ── CSS ── injected once on mount ── */
const REPLAY_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  :root {
    --g:      #00ff41;
    --g50:    rgba(0,255,65,0.5);
    --g25:    rgba(0,255,65,0.25);
    --g12:    rgba(0,255,65,0.12);
    --g06:    rgba(0,255,65,0.06);
    --red:    #ff3b3b;
    --red12:  rgba(255,59,59,0.12);
    --yellow: #ffd700;
    --bg:     #040404;
    --bg2:    #080808;
    --border: rgba(0,255,65,0.16);
    --borderW:rgba(255,255,255,0.06);
    --muted:  rgba(255,255,255,0.3);
    --faint:  rgba(255,255,255,0.05);
    --bebas:  'Bebas Neue', sans-serif;
    --mono:   'Space Mono', monospace;
  }

  .rp-grid { position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:linear-gradient(rgba(0,255,65,0.02) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,255,65,0.02) 1px,transparent 1px);
    background-size:48px 48px; }
  .rp-scan { position:fixed;inset:0;pointer-events:none;z-index:1;
    background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.05) 3px,rgba(0,0,0,0.05) 4px); }
  .rp-vig  { position:fixed;inset:0;pointer-events:none;z-index:1;
    background:radial-gradient(ellipse 110% 110% at 50% 50%,transparent 30%,rgba(0,0,0,0.58) 100%); }

  .rp-wrap {
    padding:22px 24px 44px;font-family:var(--mono);
    color:rgba(255,255,255,0.88);position:relative;z-index:10;
    overflow-y:auto;height:100%;
  }
  .rp-wrap::-webkit-scrollbar{width:3px}
  .rp-wrap::-webkit-scrollbar-thumb{background:var(--border)}

  .rp-ph { display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px; }
  .rp-title { font-family:var(--bebas);font-size:30px;color:#fff;letter-spacing:3px;line-height:1; }
  .rp-title span { color:var(--g); }
  .rp-meta { font-size:8px;color:var(--muted);letter-spacing:2px;margin-top:5px; }

  .rp-btn {
    padding:9px 22px;font-family:var(--mono);font-size:10px;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;border:none;cursor:pointer;
    clip-path:polygon(7px 0%,100% 0%,calc(100% - 7px) 100%,0% 100%);
    transition:all 0.2s;position:relative;overflow:hidden;
  }
  .rp-btn::before { content:'';position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);
    transform:translateX(-100%);transition:transform 0.5s; }
  .rp-btn:hover::before { transform:translateX(100%); }
  .rp-btn-p { background:var(--g);color:#000; }
  .rp-btn-p:hover { background:#2dff5c;box-shadow:0 0 28px var(--g25);transform:translateY(-1px); }
  .rp-btn-g { background:transparent;color:var(--muted);border:1px solid var(--borderW); }
  .rp-btn-g:hover { border-color:var(--border);color:#fff;background:var(--g06); }
  .rp-btn-r { background:var(--red12);color:var(--red);border:1px solid rgba(255,59,59,0.25); }
  .rp-btn-r:hover { background:rgba(255,59,59,0.2);box-shadow:0 0 16px rgba(255,59,59,0.18); }
  .rp-btn:disabled { opacity:0.3;pointer-events:none; }
  .rp-btn-err { background:var(--red) !important;color:#fff !important; }
  .rp-btn-ok  { background:var(--g) !important;color:#000 !important; }

  .rp-setup {
    background:var(--bg2);border:1px solid rgba(0,255,65,0.2);
    position:relative;overflow:hidden;margin-bottom:14px;
  }
  .rp-setup::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--g),transparent);opacity:0.55; }
  .rp-setup-hdr {
    display:flex;align-items:center;justify-content:space-between;
    padding:13px 20px;border-bottom:1px solid var(--borderW);
  }
  .rp-setup-title {
    font-size:8px;color:rgba(255,255,255,0.28);letter-spacing:4px;text-transform:uppercase;
    display:flex;align-items:center;gap:7px;
  }
  .rp-setup-title::before { content:'\\25CC';color:var(--g);font-size:10px; }
  .rp-setup-hint { font-size:8px;color:rgba(0,255,65,0.3);letter-spacing:3px; }

  .rp-setup-body { padding:20px;display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:14px;align-items:end; }

  .rp-field {}
  .rp-field-lbl { font-size:7px;color:rgba(255,255,255,0.22);letter-spacing:4px;text-transform:uppercase;margin-bottom:7px;display:block; }

  .rp-sel-wrap { position:relative; }
  .rp-sel-wrap::after { content:'\\25BE';position:absolute;right:12px;top:50%;transform:translateY(-50%);
    font-size:9px;color:var(--muted);pointer-events:none; }
  .rp-sel {
    width:100%;appearance:none;-webkit-appearance:none;
    background:rgba(0,0,0,0.4);border:1px solid var(--borderW);
    font-family:var(--mono);font-size:10px;letter-spacing:2px;
    color:rgba(255,255,255,0.7);padding:10px 32px 10px 14px;outline:none;
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
    transition:all 0.15s;
  }
  .rp-sel:focus { border-color:var(--g50);color:#fff;background:rgba(0,255,65,0.04); }
  .rp-sel option { background:#0c0c0c;color:#fff; }

  .rp-date-wrap {
    display:flex;align-items:center;border:1px solid var(--borderW);
    background:rgba(0,0,0,0.4);transition:border-color 0.2s;
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .rp-date-wrap:focus-within { border-color:var(--g50);background:rgba(0,255,65,0.03); }
  .rp-date-wrap input[type="datetime-local"] {
    flex:1;background:transparent;border:none;outline:none;
    font-family:var(--mono);font-size:10px;color:rgba(255,255,255,0.7);
    padding:10px 14px;letter-spacing:1px;
    color-scheme:dark;
  }
  .rp-date-wrap input[type="datetime-local"]:focus { color:#fff; }

  .rp-speed-wrap {
    display:flex;align-items:center;border:1px solid var(--borderW);
    background:rgba(0,0,0,0.4);
    clip-path:polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%);
  }
  .rp-speed-val {
    flex:1;padding:10px 14px;font-family:var(--bebas);font-size:22px;
    color:var(--g);letter-spacing:2px;line-height:1;
  }
  .rp-speed-suffix { font-size:8px;color:var(--muted);letter-spacing:2px;padding-right:12px; }
  .rp-speed-btns { display:flex;flex-direction:column;border-left:1px solid var(--borderW); }
  .rp-speed-btn {
    flex:1;padding:0 10px;font-size:10px;color:var(--muted);
    border:none;background:transparent;font-family:var(--mono);
    transition:all 0.12s;cursor:pointer;
  }
  .rp-speed-btn:hover { color:var(--g);background:var(--g06); }

  .rp-cta-row {
    padding:16px 20px;border-top:1px solid var(--borderW);
    display:flex;align-items:center;gap:12px;
  }
  .rp-cta-hint { font-size:8px;color:rgba(255,255,255,0.15);letter-spacing:2px; }

  .rp-speed-presets { display:flex;gap:4px;margin-left:auto; }
  .rp-sp {
    font-size:8px;color:var(--muted);letter-spacing:1px;
    border:1px solid var(--borderW);padding:4px 9px;
    transition:all 0.15s;font-family:var(--mono);cursor:pointer;background:transparent;
    clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%);
  }
  .rp-sp:hover { color:var(--g);border-color:var(--border);background:var(--g06); }
  .rp-sp.active { color:var(--g);border-color:var(--g);background:var(--g06); }

  .rp-active { display:flex;flex-direction:column;gap:14px; }

  .rp-status-bar {
    display:flex;align-items:center;gap:14px;
    background:var(--bg2);border:1px solid rgba(0,255,65,0.2);
    padding:12px 18px;position:relative;overflow:hidden;
  }
  .rp-status-bar::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,var(--g),transparent);opacity:0.6; }
  .rp-status-dot { width:8px;height:8px;border-radius:50%;background:var(--g);flex-shrink:0;
    animation:rpPulse 1.2s ease-in-out infinite; }
  .rp-status-dot.paused { background:var(--yellow);animation:none; }
  .rp-status-lbl { font-size:9px;letter-spacing:3px;text-transform:uppercase; }
  .rp-status-lbl.playing { color:var(--g); }
  .rp-status-lbl.paused  { color:var(--yellow); }
  .rp-status-pair { font-family:var(--bebas);font-size:18px;color:#fff;letter-spacing:2px;margin-left:4px; }
  .rp-status-tf   { font-size:8px;color:var(--muted);letter-spacing:2px;
    border:1px solid var(--borderW);padding:2px 8px; }
  .rp-status-time { font-family:var(--bebas);font-size:16px;color:rgba(255,255,255,0.5);letter-spacing:2px;margin-left:auto; }
  .rp-status-speed { font-size:8px;color:rgba(0,255,65,0.5);letter-spacing:3px; }
  .rp-vdiv { width:1px;height:18px;background:var(--borderW); }

  .rp-chart-card {
    background:var(--bg2);border:1px solid rgba(0,255,65,0.2);
    position:relative;overflow:hidden;
  }
  .rp-chart-card::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,var(--g),transparent);opacity:0.55; }
  .rp-chart-hdr {
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 16px;border-bottom:1px solid var(--borderW);
  }
  .rp-chart-title { font-size:8px;color:rgba(255,255,255,0.25);letter-spacing:4px;
    display:flex;align-items:center;gap:7px; }
  .rp-chart-title::before { content:'\\25CC';color:var(--g);font-size:10px; }
  .rp-controls {
    display:flex;align-items:center;gap:8px;padding:12px 16px;
    border-top:1px solid var(--borderW);background:rgba(0,0,0,0.25);
  }

  .rp-timeline { flex:1;position:relative;height:24px;display:flex;align-items:center; }
  .rp-timeline-track {
    width:100%;height:3px;background:rgba(255,255,255,0.06);
    position:relative;overflow:visible;
  }
  .rp-timeline-fill { height:100%;background:var(--g);transition:width 0.3s ease; }
  .rp-timeline-thumb {
    position:absolute;top:50%;right:0;width:10px;height:10px;
    background:var(--g);border:1px solid rgba(0,0,0,0.5);
    transform:translate(50%,-50%);
    clip-path:polygon(2px 0%,100% 0%,calc(100% - 2px) 100%,0% 100%);
    box-shadow:0 0 8px var(--g50);
  }
  .rp-timeline input[type=range] {
    position:absolute;inset:0;width:100%;opacity:0;height:24px;
    cursor:pointer;
  }
  .rp-time-lbl { font-size:8px;color:var(--muted);letter-spacing:1px;white-space:nowrap;width:110px;text-align:right; }

  .rp-ctrl {
    width:32px;height:32px;border:1px solid var(--borderW);
    display:flex;align-items:center;justify-content:center;
    font-size:12px;color:var(--muted);transition:all 0.15s;
    flex-shrink:0;background:transparent;font-family:var(--mono);cursor:pointer;
    clip-path:polygon(4px 0%,100% 0%,calc(100% - 4px) 100%,0% 100%);
  }
  .rp-ctrl:hover { border-color:var(--border);color:#fff;background:var(--g06); }
  .rp-ctrl.primary {
    width:40px;height:40px;background:var(--g);border-color:var(--g);
    color:#000;font-size:14px;
  }
  .rp-ctrl.primary:hover { background:#2dff5c;box-shadow:0 0 16px var(--g25); }

  .rp-info-strip {
    display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
    background:var(--borderW);
  }
  .rp-info-item { background:var(--bg2);padding:10px 14px; }
  .rp-info-lbl { font-size:7px;color:rgba(255,255,255,0.2);letter-spacing:3px;text-transform:uppercase;margin-bottom:5px; }
  .rp-info-val { font-family:var(--bebas);font-size:18px;color:rgba(255,255,255,0.6);letter-spacing:1px; }
  .rp-info-val.gr { color:var(--g); }
  .rp-info-val.rd { color:var(--red); }

  .rp-order-strip {
    background:var(--bg2);border:1px solid rgba(0,255,65,0.2);
    padding:14px 20px;display:grid;
    grid-template-columns:1fr 1fr 1fr auto auto;gap:12px;align-items:end;
    position:relative;overflow:hidden;
  }
  .rp-order-strip::before { content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,var(--g),transparent);opacity:0.4; }
  .rp-order-err { grid-column:1/-1;font-size:9px;color:var(--red);letter-spacing:1px; }

  .rp-inp-wrap {
    border:1px solid var(--borderW);background:rgba(0,0,0,0.4);
    clip-path:polygon(4px 0%,100% 0%,calc(100% - 4px) 100%,0% 100%);
    display:flex;align-items:center;transition:border-color 0.15s;
  }
  .rp-inp-wrap:focus-within { border-color:var(--g50); }
  .rp-inp-wrap input {
    flex:1;background:transparent;border:none;outline:none;
    font-family:var(--mono);font-size:11px;color:#fff;
    padding:9px 12px;letter-spacing:1px;
  }
  .rp-inp-wrap input::placeholder { color:rgba(255,255,255,0.15); }
  .rp-inp-unit { font-size:8px;color:var(--muted);letter-spacing:2px;padding:0 10px;
    border-left:1px solid var(--borderW);flex-shrink:0; }

  .rp-ticker {
    position:fixed;bottom:0;left:0;right:0;z-index:60;
    background:rgba(4,4,4,0.97);border-top:1px solid var(--border);
    height:28px;display:flex;align-items:center;overflow:hidden;
  }
  .rp-tick-lbl { flex-shrink:0;height:100%;padding:0 12px;display:flex;align-items:center;
    background:var(--g);font-size:7px;font-weight:700;color:#000;letter-spacing:4px; }
  .rp-tick-inner { display:flex;gap:40px;white-space:nowrap;
    animation:scrollTick6 22s linear infinite;font-size:9px;padding:0 16px; }
  @keyframes scrollTick6 { from{transform:translateX(0)} to{transform:translateX(-50%)} }
  .rp-tick-up { color:var(--g); }
  .rp-tick-dn { color:var(--red); }
  .rp-tick-sym { color:var(--muted);letter-spacing:2px;margin-right:5px; }

  @keyframes rpPulse {
    0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,255,65,0.4)}
    50%{opacity:0.7;box-shadow:0 0 0 5px transparent}
  }

  .rp-fu { animation:rpFadeUp 0.35s ease both; }
  @keyframes rpFadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .rp-d1{animation-delay:0.05s} .rp-d2{animation-delay:0.1s}
  .rp-d3{animation-delay:0.15s} .rp-d4{animation-delay:0.2s}
`;

const TICKS = [
  { s: "BTC", p: "$84,220.44", c: "+2.31%", up: true },
  { s: "ETH", p: "$3,941.12", c: "+1.84%", up: true },
  { s: "SOL", p: "$142.88", c: "-0.71%", up: false },
  { s: "BNB", p: "$621.50", c: "+0.42%", up: true },
  { s: "AVAX", p: "$38.12", c: "-1.18%", up: false },
  { s: "DOGE", p: "$0.1822", c: "+5.09%", up: true },
];

const SPEEDS = [1, 2, 5, 10, 20];

/* ── helpers ── */
// Lightweight Charts treats all timestamps as UTC — offset to local so the
// x-axis labels match the user's timezone.
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

/** Format epoch seconds (local-adjusted) to "March 10, 8:00 AM" for crosshair */
function formatDateTime12h(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const time = m === 0 ? `${h}:00 ${ampm}` : `${h}:${String(m).padStart(2, "0")} ${ampm}`;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`;
}

function candleToLW(c: Candle): CandlestickData<Time> {
  return {
    time: (new Date(c.ts).getTime() / 1000 + TZ_OFFSET_SEC) as Time,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  };
}

const TF_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

function bucketStart(epochMs: number, tfMs: number): number {
  return Math.floor(epochMs / tfMs) * tfMs;
}

function parseSessionTs(raw: string): number {
  const n = Number(raw);
  if (!isNaN(n) && n > 1e12) return n;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/* ── REPLAY CHART (Lightweight Charts with real candle data) ── */
interface ReplayChartProps {
  session: ReplaySession | null;
  pairId: string | null;
}

function ReplayChart({ session, pairId }: ReplayChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBucketRef = useRef<number>(0);

  // Create chart on mount
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#080808" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "rgba(0,255,65,0.04)" },
        horzLines: { color: "rgba(0,255,65,0.04)" },
      },
      crosshair: {
        vertLine: { color: "#4b5563", labelBackgroundColor: "#374151" },
        horzLine: { color: "#4b5563", labelBackgroundColor: "#374151" },
      },
      timeScale: {
        borderColor: "rgba(0,255,65,0.15)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: () => "",
      },
      localization: { timeFormatter: formatDateTime12h },
      rightPriceScale: { borderColor: "rgba(0,255,65,0.15)" },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00ff41",
      downColor: "#ff3b3b",
      borderUpColor: "#00ff41",
      borderDownColor: "#ff3b3b",
      wickUpColor: "#00ff41",
      wickDownColor: "#ff3b3b",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    });
    ro.observe(chartContainerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Fetch candles when session starts or current_ts crosses a candle boundary
  useEffect(() => {
    if (!session || !pairId || !seriesRef.current) return;

    const ts = parseSessionTs(session.current_ts);
    if (ts <= 0) return;

    const tfMs = TF_MS[session.timeframe] ?? 60_000;
    const bucket = bucketStart(ts, tfMs);
    if (bucket === lastBucketRef.current && lastBucketRef.current !== 0) return;
    lastBucketRef.current = bucket;

    (async () => {
      try {
        const beforeIso = new Date(ts + tfMs).toISOString();
        const res = await getCandles(pairId, {
          timeframe: session.timeframe as Timeframe,
          limit: 200,
          before: beforeIso,
        });
        if (seriesRef.current && res.data.candles.length > 0) {
          seriesRef.current.setData(res.data.candles.map(candleToLW));
          chartRef.current?.timeScale().fitContent();
        }
      } catch {
        // non-fatal
      }
    })();
  }, [session?.current_ts, session?.timeframe, pairId, session]);

  // Listen for replay.tick SSE — update last candle in real-time
  useEffect(() => {
    if (!session || !pairId) return;

    function onReplayTick(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.pairId !== pairId || !seriesRef.current) return;

      const tickTs = Number(detail.sessionTs);
      const tfMs = TF_MS[session!.timeframe] ?? 60_000;
      const bucket = bucketStart(tickTs, tfMs);

      if (bucket !== lastBucketRef.current) {
        // New candle boundary — will be picked up by the effect above
        return;
      }

      // Same candle — update in place
      const price = parseFloat(detail.last);
      seriesRef.current.update({
        time: (bucket / 1000 + TZ_OFFSET_SEC) as Time,
        open: price,
        high: price,
        low: price,
        close: price,
      });
    }

    window.addEventListener("sse:replay.tick", onReplayTick);
    return () => window.removeEventListener("sse:replay.tick", onReplayTick);
  }, [session, pairId]);

  // Reset when session changes (new pair / new session)
  useEffect(() => {
    lastBucketRef.current = 0;
  }, [pairId]);

  return <div ref={chartContainerRef} style={{ width: "100%", height: 380 }} />;
}

/* ─────────────────────────────────────────
   MAIN REPLAY COMPONENT
───────────────────────────────────────── */
export default function ReplayPage() {
  const pairs = useAppStore((s) => s.pairs);

  // Map symbol like "BTC/USD" to pair id
  const pairIdBySymbol = useCallback(
    (sym: string): UUID | null => {
      const p = pairs.find((pr) => pr.symbol === sym);
      return p?.id ?? null;
    },
    [pairs],
  );

  const pairSymbolById = useCallback(
    (id: UUID): string => {
      const p = pairs.find((pr) => pr.id === id);
      return p?.symbol ?? "???";
    },
    [pairs],
  );

  // UI state
  const [pair, setPair] = useState("BTC/USD");
  const [tf, setTf] = useState("15m");
  const [startTime, setStart] = useState("2026-03-09T14:00");
  const [endTime, setEnd] = useState("2026-03-09T18:00");
  const [speed, setSpeed] = useState(1);
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [qty, setQty] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [clock, setClock] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Session state (from backend)
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startLoading, setStartLoading] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [buyFlash, setBuyFlash] = useState<"ok" | "err" | null>(null);
  const [sellFlash, setSellFlash] = useState<"ok" | "err" | null>(null);

  // Info strip data
  const [sessionPnl, setSessionPnl] = useState<string>("——");
  const [openPosition, setOpenPosition] = useState<string>("NONE");
  const [tradesMade, setTradesMade] = useState<number>(0);
  const [balance, setBalance] = useState<string>("$100K");

  // Inject CSS
  useEffect(() => {
    const id = "tradr-replay-css";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = REPLAY_CSS;
      document.head.appendChild(s);
    }
  }, []);

  // Clock
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const mos = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const p = (v: number) => String(v).padStart(2, "0");
      setClock(
        `SEASON 01 \u00B7 ${days[n.getDay()]} ${p(n.getDate())} ${mos[n.getMonth()]} ${n.getFullYear()} \u00B7 ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())} EST`,
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Check for existing active session on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await getActiveReplay();
        const s = res.data.session;
        if (s && s.is_active) {
          setSession(s);
          setActive(true);
          setPlaying(!s.is_paused);
          // Resolve pair symbol
          const sym = pairSymbolById(s.pair_id);
          if (sym !== "???") setPair(sym);
          setTf(s.timeframe);
          setSpeed(parseFloat(s.speed) || 1);
        }
      } catch {
        // No active session — that's fine
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs]);

  // SSE replay.tick — update current time + progress
  useEffect(() => {
    function onReplayTick(e: Event) {
      const detail = (e as CustomEvent).detail as {
        sessionTs: number;
        pairId: string;
      };
      setSession((prev) => {
        if (!prev) return prev;
        return { ...prev, current_ts: String(detail.sessionTs) };
      });
    }
    window.addEventListener("sse:replay.tick", onReplayTick);
    return () => window.removeEventListener("sse:replay.tick", onReplayTick);
  }, []);

  // Compute progress from session timestamps
  useEffect(() => {
    if (!session || !active) return;
    const startMs = new Date(session.created_at).getTime();
    const endMs = session.end_ts ? new Date(session.end_ts).getTime() : startMs + 4 * 3600_000;
    const currentMs = Number(session.current_ts) || new Date(session.current_ts).getTime();
    if (endMs <= startMs) return;
    const pct = Math.min(100, Math.max(0, ((currentMs - startMs) / (endMs - startMs)) * 100));
    setProgress(pct);
    if (pct >= 100) setPlaying(false);
  }, [session?.current_ts, session?.created_at, session?.end_ts, active, session]);

  // Poll info strip data while session is active
  useEffect(() => {
    if (!active || !session) return;
    let cancelled = false;

    async function fetchInfo() {
      if (cancelled) return;
      try {
        const [posRes, ordersRes, walletsRes] = await Promise.all([
          getPositions({ pairId: session!.pair_id }),
          listOrders({ pairId: session!.pair_id, limit: 200 }),
          listWallets(),
        ]);

        if (cancelled) return;

        // Position
        const pos: Position | undefined = posRes.data.positions.find(
          (p) => p.pair_id === session!.pair_id,
        );
        if (pos && parseFloat(pos.base_qty) !== 0) {
          const qty = parseFloat(pos.base_qty);
          const dir = qty > 0 ? "LONG" : "SHORT";
          setOpenPosition(`${Math.abs(qty).toFixed(6)} ${dir}`);
          const pnl = parseFloat(pos.unrealized_pnl_quote) + parseFloat(pos.realized_pnl_quote);
          const sign = pnl >= 0 ? "+" : "";
          setSessionPnl(`${sign}$${pnl.toFixed(2)}`);
        } else {
          setOpenPosition("NONE");
          // Sum realized PnL from all positions for this pair
          const realized = pos ? parseFloat(pos.realized_pnl_quote) : 0;
          setSessionPnl(realized !== 0 ? `${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}` : "——");
        }

        // Trades count (filled orders)
        const filled = ordersRes.data.orders.filter((o) => o.status === "FILLED" || o.status === "PARTIALLY_FILLED");
        setTradesMade(filled.length);

        // Balance (USD wallet)
        const usdWallet = walletsRes.data.wallets.find((w) => w.symbol === "USD");
        if (usdWallet) {
          const bal = parseFloat(usdWallet.balance);
          if (bal >= 1000) {
            setBalance(`$${(bal / 1000).toFixed(bal >= 10000 ? 0 : 1)}K`);
          } else {
            setBalance(`$${bal.toFixed(2)}`);
          }
        }
      } catch {
        // Silently ignore polling errors
      }
    }

    fetchInfo();
    const id = setInterval(fetchInfo, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, session]);

  // Playback tick — driven by SSE from backend, but we keep a local
  // fallback interval for visual smoothness when SSE ticks are sparse
  useEffect(() => {
    if (playing && !session) {
      // Pure local mode (no backend session yet)
      intervalRef.current = setInterval(() => {
        setProgress((p) => {
          if (p >= 100) {
            setPlaying(false);
            return 100;
          }
          return Math.min(p + 0.4 * speed, 100);
        });
      }, 100);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, session]);

  /* ── API handlers ── */

  async function handleStart() {
    setStartError(null);
    const pairId = pairIdBySymbol(pair);
    if (!pairId) {
      setStartError("Pair not found");
      return;
    }
    setStartLoading(true);
    try {
      const startTs = new Date(startTime).toISOString();
      const endTs = endTime ? new Date(endTime).toISOString() : undefined;
      const res = await startReplay({
        pairId,
        startTs,
        endTs,
        timeframe: tf,
        speed,
      });
      setSession(res.data.session);
      setActive(true);
      setPlaying(true);
      setProgress(0);
      // Reset info strip
      setSessionPnl("——");
      setOpenPosition("NONE");
      setTradesMade(0);
      setBalance("$100K");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setStartError(message);
      setTimeout(() => setStartError(null), 3000);
    } finally {
      setStartLoading(false);
    }
  }

  async function handleStop() {
    if (session) {
      try {
        await stopReplay(session.pair_id);
      } catch {
        // Best effort
      }
    }
    setSession(null);
    setActive(false);
    setPlaying(false);
    setProgress(0);
    setSessionPnl("——");
    setOpenPosition("NONE");
    setTradesMade(0);
    setBalance("$100K");
  }

  async function togglePlay() {
    if (!session) return;
    try {
      if (playing) {
        const res = await pauseReplay(session.pair_id);
        setSession(res.data.session);
        setPlaying(false);
      } else {
        const res = await resumeReplay(session.pair_id);
        setSession(res.data.session);
        setPlaying(true);
      }
    } catch {
      // Toggle local state anyway for responsiveness
      setPlaying((p) => !p);
    }
  }

  async function handleSeek(pct: number) {
    setProgress(pct);
    setPlaying(false);
    if (!session) return;
    // Compute the target timestamp from progress %
    const startMs = new Date(startTime).getTime();
    const endMs = endTime ? new Date(endTime).getTime() : startMs + 4 * 3600_000;
    const targetMs = startMs + (pct / 100) * (endMs - startMs);
    const targetIso = new Date(targetMs).toISOString();
    try {
      await pauseReplay(session.pair_id);
      const res = await seekReplay(session.pair_id, targetIso);
      setSession(res.data.session);
    } catch {
      // Best effort
    }
  }

  async function handleOrder(side: "BUY" | "SELL") {
    if (!session || !qty) return;
    setOrderError(null);
    const flashSetter = side === "BUY" ? setBuyFlash : setSellFlash;
    try {
      await placeOrder({
        pairId: session.pair_id,
        side,
        type: "MARKET",
        qty,
      });
      flashSetter("ok");
      setQty("");
      setStopLoss("");
      setTakeProfit("");
      setTimeout(() => flashSetter(null), 1200);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setOrderError(message);
      flashSetter("err");
      setTimeout(() => {
        flashSetter(null);
        setOrderError(null);
      }, 3000);
    }
  }

  const currentTimeLabel = (() => {
    if (session?.current_ts) {
      const ts = Number(session.current_ts) || new Date(session.current_ts).getTime();
      if (!isNaN(ts)) {
        return new Date(ts).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
    }
    if (!startTime) return "\u2014\u2014";
    const s = new Date(startTime);
    const addMs = (progress / 100) * 4 * 3600000;
    const cur = new Date(s.getTime() + addMs);
    return cur.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  })();

  // Available pair symbols for the dropdown
  const pairSymbols = pairs.length > 0 ? pairs.map((p) => p.symbol) : ["BTC/USD", "ETH/USD", "SOL/USD"];

  return (
    <div className="rp-wrap">
      <div className="rp-grid" />
      <div className="rp-scan" />
      <div className="rp-vig" />

      {/* PAGE HEADER */}
      <div className="rp-ph rp-fu">
        <div>
          <div className="rp-title">
            MARKET <span>REPLAY</span>
          </div>
          <div className="rp-meta">{clock}</div>
        </div>
      </div>

      {/* SETUP CARD */}
      <div className="rp-setup rp-fu rp-d1">
        <div className="rp-setup-hdr">
          <span className="rp-setup-title">Replay Configuration</span>
          <span className="rp-setup-hint">{"\u25B6"} PRACTICE WITHOUT RISK</span>
        </div>

        <div className="rp-setup-body">
          <div className="rp-field">
            <label className="rp-field-lbl">Trading Pair</label>
            <div className="rp-sel-wrap">
              <select className="rp-sel" value={pair} onChange={(e) => setPair(e.target.value)} disabled={active}>
                {pairSymbols.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="rp-field">
            <label className="rp-field-lbl">Timeframe</label>
            <div className="rp-sel-wrap">
              <select className="rp-sel" value={tf} onChange={(e) => setTf(e.target.value)} disabled={active}>
                {["1m", "5m", "15m", "1h", "4h", "1d"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="rp-field">
            <label className="rp-field-lbl">Start Time</label>
            <div className="rp-date-wrap">
              <input type="datetime-local" value={startTime} onChange={(e) => setStart(e.target.value)} disabled={active} />
            </div>
          </div>

          <div className="rp-field">
            <label className="rp-field-lbl">End Time (optional)</label>
            <div className="rp-date-wrap">
              <input type="datetime-local" value={endTime} onChange={(e) => setEnd(e.target.value)} disabled={active} />
            </div>
          </div>
        </div>

        {/* SPEED ROW */}
        <div style={{ padding: "0 20px 20px", display: "grid", gridTemplateColumns: "200px 1fr", gap: 14 }}>
          <div className="rp-field">
            <label className="rp-field-lbl">Playback Speed</label>
            <div className="rp-speed-wrap">
              <div className="rp-speed-val">{speed}x</div>
              <span className="rp-speed-suffix">SPEED</span>
              <div className="rp-speed-btns">
                <button className="rp-speed-btn" onClick={() => setSpeed((s) => Math.min(s + 1, 20))}>
                  {"\u25B2"}
                </button>
                <button className="rp-speed-btn" onClick={() => setSpeed((s) => Math.max(s - 1, 1))}>
                  {"\u25BC"}
                </button>
              </div>
            </div>
          </div>
          <div className="rp-field">
            <label className="rp-field-lbl">Speed Presets</label>
            <div className="rp-speed-presets" style={{ marginLeft: 0 }}>
              {SPEEDS.map((s) => (
                <button key={s} className={`rp-sp${speed === s ? " active" : ""}`} onClick={() => setSpeed(s)}>
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rp-cta-row">
          {!active ? (
            <>
              <button
                className={`rp-btn ${startError ? "rp-btn-err" : "rp-btn-p"}`}
                onClick={handleStart}
                disabled={startLoading}
              >
                {startLoading ? "STARTING..." : startError ? startError.toUpperCase() : "\u25B6 START REPLAY SESSION"}
              </button>
              <span className="rp-cta-hint">$100,000 PAPER BALANCE · NO REAL RISK</span>
            </>
          ) : (
            <>
              <button className="rp-btn rp-btn-r" onClick={handleStop}>
                {"\u25A0"} END SESSION
              </button>
              <span className="rp-cta-hint" style={{ color: "rgba(0,255,65,0.3)" }}>
                SESSION ACTIVE · {pair} · {tf} · {speed}x
              </span>
            </>
          )}
        </div>
      </div>

      {/* ACTIVE REPLAY */}
      {active && (
        <div className="rp-active rp-fu">
          {/* STATUS BAR */}
          <div className="rp-status-bar">
            <div className={`rp-status-dot${playing ? "" : " paused"}`} />
            <span className={`rp-status-lbl${playing ? " playing" : " paused"}`}>
              {playing ? "PLAYING" : "PAUSED"}
            </span>
            <div className="rp-vdiv" />
            <span className="rp-status-pair">{pair}</span>
            <span className="rp-status-tf">{tf}</span>
            <div className="rp-vdiv" />
            <span style={{ fontSize: 8, color: "var(--muted)", letterSpacing: 2 }}>{currentTimeLabel}</span>
            <span className="rp-status-time" style={{ marginLeft: "auto" }}>
              {progress.toFixed(0)}%
            </span>
            <div className="rp-vdiv" />
            <span className="rp-status-speed">{speed}x</span>
          </div>

          {/* CHART */}
          <div className="rp-chart-card">
            <div className="rp-chart-hdr">
              <span className="rp-chart-title">
                {pair} · {tf} · REPLAY MODE
              </span>
              <span style={{ fontSize: 8, color: "rgba(0,255,65,0.3)", letterSpacing: 3 }}>FUTURE HIDDEN</span>
            </div>

            <ReplayChart session={session} pairId={session?.pair_id ?? pairIdBySymbol(pair)} />

            {/* INFO STRIP */}
            <div className="rp-info-strip">
              {[
                { lbl: "Session PnL", val: sessionPnl, cls: sessionPnl.startsWith("+") ? "gr" : sessionPnl.startsWith("-") ? "rd" : "" },
                { lbl: "Open Position", val: openPosition, cls: openPosition !== "NONE" ? "gr" : "" },
                { lbl: "Trades Made", val: String(tradesMade), cls: "" },
                { lbl: "Balance", val: balance, cls: "gr" },
              ].map((item, i) => (
                <div key={i} className="rp-info-item">
                  <div className="rp-info-lbl">{item.lbl}</div>
                  <div className={`rp-info-val${item.cls ? " " + item.cls : ""}`}>{item.val}</div>
                </div>
              ))}
            </div>

            {/* PLAYBACK CONTROLS */}
            <div className="rp-controls">
              <button
                className="rp-ctrl"
                title="Restart"
                onClick={() => handleSeek(0)}
              >
                {"\u23EE"}
              </button>
              <button className="rp-ctrl" title="Step back" onClick={() => handleSeek(Math.max(progress - 2, 0))}>
                {"\u25C0\u25C0"}
              </button>
              <button className="rp-ctrl primary" title={playing ? "Pause" : "Play"} onClick={togglePlay}>
                {playing ? "\u23F8" : "\u25B6"}
              </button>
              <button className="rp-ctrl" title="Step forward" onClick={() => handleSeek(Math.min(progress + 2, 100))}>
                {"\u25B6\u25B6"}
              </button>

              {/* TIMELINE */}
              <div className="rp-timeline">
                <div className="rp-timeline-track">
                  <div className="rp-timeline-fill" style={{ width: `${progress}%` }} />
                  <div className="rp-timeline-thumb" style={{ left: `${progress}%` }} />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={progress}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                />
              </div>

              <span className="rp-time-lbl">{currentTimeLabel}</span>

              <div style={{ display: "flex", gap: 3, marginLeft: 4 }}>
                {SPEEDS.map((s) => (
                  <button key={s} className={`rp-sp${speed === s ? " active" : ""}`} onClick={() => setSpeed(s)}>
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ORDER ENTRY */}
          <div className="rp-order-strip">
            <div className="rp-field">
              <label className="rp-field-lbl">Order Size (USD)</label>
              <div className="rp-inp-wrap">
                <input type="number" placeholder="0.00" value={qty} onChange={(e) => setQty(e.target.value)} />
                <span className="rp-inp-unit">USD</span>
              </div>
            </div>
            <div className="rp-field">
              <label className="rp-field-lbl">Stop Loss</label>
              <div className="rp-inp-wrap">
                <input type="number" placeholder="optional" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
                <span className="rp-inp-unit">USD</span>
              </div>
            </div>
            <div className="rp-field">
              <label className="rp-field-lbl">Take Profit</label>
              <div className="rp-inp-wrap">
                <input type="number" placeholder="optional" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
                <span className="rp-inp-unit">USD</span>
              </div>
            </div>
            <button
              className={`rp-btn ${buyFlash === "ok" ? "rp-btn-ok" : buyFlash === "err" ? "rp-btn-err" : "rp-btn-p"}`}
              style={{ marginBottom: 0 }}
              onClick={() => handleOrder("BUY")}
              disabled={!qty}
            >
              {"\u25B2"} BUY LONG
            </button>
            <button
              className={`rp-btn ${sellFlash === "ok" ? "rp-btn-ok" : sellFlash === "err" ? "rp-btn-err" : "rp-btn-r"}`}
              style={{ marginBottom: 0 }}
              onClick={() => handleOrder("SELL")}
              disabled={!qty}
            >
              {"\u25BC"} SELL SHORT
            </button>
            {orderError && <div className="rp-order-err">{orderError}</div>}
          </div>
        </div>
      )}

      {/* TICKER */}
      <div className="rp-ticker">
        <div className="rp-tick-lbl">LIVE</div>
        <div style={{ overflow: "hidden", flex: 1 }}>
          <div className="rp-tick-inner">
            {[...TICKS, ...TICKS].map((t, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="rp-tick-sym">{t.s}</span>
                <span style={{ color: "rgba(255,255,255,0.65)" }}>{t.p}</span>
                <span className={t.up ? "rp-tick-up" : "rp-tick-dn"}>
                  {t.up ? "+" : ""}
                  {t.c}
                </span>
                <span style={{ color: "rgba(255,255,255,0.06)", marginLeft: 6 }}>|</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
