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
import { getActive as getActiveReplay } from "@/api/endpoints/replay";
import { useAppStore } from "@/stores/appStore";
import type { ReplaySession } from "@/types/api";

/* ── helpers ── */
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

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
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

function bucketStart(epochMs: number, tfMs: number): number {
  return Math.floor(epochMs / tfMs) * tfMs;
}

function parseSessionTs(raw: string): number {
  const n = Number(raw);
  if (!isNaN(n) && n > 1e12) return n; // epoch ms
  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

export default function ReplayChart() {
  const pairs = useAppStore((s) => s.pairs);

  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBucketRef = useRef<number>(0);
  const sessionRef = useRef<ReplaySession | null>(null);
  const chartReadyRef = useRef(false);

  const [session, setSession] = useState<ReplaySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentTs, setCurrentTs] = useState<number>(0);

  // Fetch active session on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getActiveReplay();
        if (!cancelled) {
          const sess = res.data.session ?? null;
          setSession(sess);
          sessionRef.current = sess;
          if (sess?.current_ts) {
            setCurrentTs(parseSessionTs(sess.current_ts));
          }
        }
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Create chart — use callback ref pattern to handle container appearing
  const initChart = useCallback((node: HTMLDivElement | null) => {
    // Cleanup previous
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
      chartReadyRef.current = false;
    }

    if (!node) return;

    const chart = createChart(node, {
      width: node.clientWidth,
      height: node.clientHeight,
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
        tickMarkFormatter: () => "",
      },
      localization: { timeFormatter: formatDateTime12h },
      rightPriceScale: { borderColor: "#1f2937" },
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
    chartReadyRef.current = true;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    });
    ro.observe(node);

    // If session already loaded, fetch candles now
    const sess = sessionRef.current;
    if (sess) {
      const ts = parseSessionTs(sess.current_ts);
      if (ts > 0) doFetchCandles(sess, ts);
    }

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      chartReadyRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch candles
  const doFetchCandles = useCallback(async (sess: ReplaySession, ts: number) => {
    const tfMs = TF_MS[sess.timeframe] ?? 60_000;
    const bucket = bucketStart(ts, tfMs);

    // Only re-fetch when we cross into a new candle bucket
    if (bucket === lastBucketRef.current && lastBucketRef.current !== 0) return;
    lastBucketRef.current = bucket;

    try {
      const beforeIso = new Date(ts + tfMs).toISOString(); // include current candle
      const res = await getCandles(sess.pair_id, {
        timeframe: sess.timeframe as Timeframe,
        limit: 50, // focused window, not weeks of history
        before: beforeIso,
      });
      if (seriesRef.current && res.data.candles.length > 0) {
        seriesRef.current.setData(res.data.candles.map(candleToLW));
        chartRef.current?.timeScale().fitContent();
      }
    } catch {
      // non-fatal
    }
  }, []);

  // Fetch candles when session loads (chart may already be ready)
  useEffect(() => {
    if (session && currentTs > 0 && chartReadyRef.current) {
      doFetchCandles(session, currentTs);
    }
  }, [session, currentTs, doFetchCandles]);

  // Listen for replay.tick SSE events
  useEffect(() => {
    function onReplayTick(e: Event) {
      const detail = (e as CustomEvent).detail;
      const sess = sessionRef.current;
      if (!sess || detail.pairId !== sess.pair_id) return;

      const tickTs = Number(detail.sessionTs);
      setCurrentTs(tickTs);

      if (!chartReadyRef.current) return;

      // Update last candle with tick data
      const tfMs = TF_MS[sess.timeframe] ?? 60_000;
      const bucket = bucketStart(tickTs, tfMs);
      const prevBucket = lastBucketRef.current;

      if (bucket !== prevBucket) {
        // New candle boundary — re-fetch to get the completed candle + new one
        doFetchCandles(sess, tickTs);
      } else if (seriesRef.current) {
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
    }

    window.addEventListener("sse:replay.tick", onReplayTick);
    return () => window.removeEventListener("sse:replay.tick", onReplayTick);
  }, [doFetchCandles]);

  // Resolve pair symbol
  const pairSymbol = session
    ? pairs.find((p) => p.id === session.pair_id)?.symbol ?? session.pair_id.slice(0, 8)
    : "";

  // Format current time
  const timeDisplay = currentTs > 0
    ? new Date(currentTs).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
      })
    : "--";

  // Always render chart container — overlay loading/empty states on top
  return (
    <div className="flex flex-col h-full relative">
      {/* Session info bar — only when session exists */}
      {session && (
        <div className="flex items-center gap-4 px-3 py-1.5 border-b border-white/[0.06] text-[9px] tracking-[2px] font-mono flex-shrink-0">
          <span className="text-[#00ff41]">{pairSymbol}</span>
          <span className="text-white/40">{session.timeframe}</span>
          <span className="text-white/40">{session.speed}x</span>
          <span className="text-white/50 ml-auto">{timeDisplay}</span>
          <span className={`w-[5px] h-[5px] rounded-full ${session.is_paused ? "bg-yellow-400" : "bg-[#00ff41] shadow-[0_0_6px_#00ff41]"}`} />
          <span className="text-white/30">{session.is_paused ? "PAUSED" : "LIVE"}</span>
        </div>
      )}

      {/* Chart container — always mounted so ref callback fires */}
      <div ref={initChart} className="flex-1 min-h-0" />

      {/* Overlay states */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0a]/80 z-10 text-white/30 text-xs tracking-widest font-mono">
          LOADING...
        </div>
      )}
      {!loading && !session && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0a0a]/80 z-10 gap-2 text-white/30 text-xs tracking-widest font-mono">
          <span>NO ACTIVE REPLAY</span>
          <a href="/replay" className="text-[#00ff41]/60 hover:text-[#00ff41] underline underline-offset-2">
            Start one from the Replay page
          </a>
        </div>
      )}
    </div>
  );
}
