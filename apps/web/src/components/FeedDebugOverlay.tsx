import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useConnectionStatus, CONNECTION_SILENT_MS, PRICE_DELAYED_MS } from "@/hooks/useConnectionStatus";
import { feedDiag, ticksInLast } from "@/lib/feedDiagnostics";
import { getFeedHealth, type FeedHealthResponse } from "@/api/endpoints/events";

// ?debug=1 overlay for the price path (2026-10-01 "PRICE DELAYED"
// investigation). Shows, live: what the banner is reacting to on the client,
// whether this SSE stream is actually subscribed to the selected pair,
// server-side feed/reconnect/event-loop health, and — for the selected pair —
// the exact price a MARKET order would fill off vs the book on screen.
// Read-only; mounted by AppLayout only when debug mode is on.

const POLL_MS = 2_000;
const DRIFT_WINDOW = 30;

function age(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function since(t: number, now: number): string {
  return t > 0 ? age(now - t) : "never";
}

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/50">{k}</span>
      <span className={bad ? "text-red-400" : "text-white/90"}>{v}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <div className="text-cyan-400/80 tracking-[1px]">{title}</div>
      {children}
    </div>
  );
}

export function FeedDebugOverlay() {
  const sseConnectionState = useAppStore((s) => s.sseConnectionState);
  const lastPriceTickAt = useAppStore((s) => s.lastPriceTickAt);
  const priceFreshAt = useAppStore((s) => s.priceFreshAt);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const { priceStale } = useConnectionStatus();

  const [, setFrame] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [health, setHealth] = useState<FeedHealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState<number | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);

  // 1s repaint + timer-drift probe: how late does a 1s interval actually fire?
  // Large drift = background-tab / Safari timer throttling (which also delays
  // the banner's own 1s staleness check and the 30s SSE heartbeat timer).
  const lastBeat = useRef(Date.now());
  const drifts = useRef<number[]>([]);
  const [visibility, setVisibility] = useState(document.visibilityState);
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      drifts.current.push(now - lastBeat.current - 1_000);
      if (drifts.current.length > DRIFT_WINDOW) drifts.current.shift();
      lastBeat.current = now;
      setFrame((f) => f + 1);
    }, 1_000);
    const onVis = () => setVisibility(document.visibilityState);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const t0 = Date.now();
      try {
        const res = await getFeedHealth(selectedPairId);
        const t1 = Date.now();
        if (cancelled) return;
        setHealth(res.data);
        setHealthErr(null);
        setRttMs(t1 - t0);
        // server clock − client clock, assuming the server stamped mid-flight
        setClockOffsetMs(res.data.serverNow - (t0 + t1) / 2);
      } catch (err) {
        if (!cancelled) setHealthErr((err as Error)?.message ?? "error");
      }
    };
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedPairId]);

  const now = Date.now();
  const maxDrift = drifts.current.length ? Math.max(...drifts.current) : 0;
  const streamMismatch =
    feedDiag.currentStreamId !== null && feedDiag.subscribedStreamId !== feedDiag.currentStreamId;
  const pairNotSubscribed =
    !!selectedPairId && !feedDiag.subscribedPairIds.includes(selectedPairId);
  const publishToSend =
    feedDiag.lastTickSentAt !== null && feedDiag.lastTickServerTs !== null
      ? feedDiag.lastTickSentAt - feedDiag.lastTickServerTs
      : null;
  const sendToRecv = feedDiag.lastTickSentAt !== null ? feedDiag.lastTickAt - feedDiag.lastTickSentAt : null;

  const pair = health?.pair ?? null;
  const fillLast = pair ? Number(pair.fillPriceSource.last) : null;
  const book = pair?.displayedBook ?? null;
  const bookMid = book?.bestBid != null && book?.bestAsk != null ? (book.bestBid + book.bestAsk) / 2 : null;
  const fillVsBookBps = fillLast !== null && bookMid ? ((fillLast - bookMid) / bookMid) * 10_000 : null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-2 left-2 z-[9999] px-2 py-1 bg-black/85 border border-cyan-400/40 text-cyan-400 font-mono text-[10px]"
      >
        FEED DEBUG {priceStale ? "· STALE" : ""}
      </button>
    );
  }

  return (
    <div className="fixed bottom-2 left-2 z-[9999] w-[340px] max-w-[calc(100vw-16px)] max-h-[80vh] overflow-y-auto bg-black/85 border border-cyan-400/40 p-2 font-mono text-[10px] leading-[14px] text-white">
      <div className="flex justify-between">
        <span className="text-cyan-400">FEED DEBUG</span>
        <button type="button" onClick={() => setCollapsed(true)} className="text-white/50 hover:text-white">
          ─
        </button>
      </div>

      <Section title="BANNER (client)">
        <Row k="sse state" v={sseConnectionState} bad={sseConnectionState !== "connected"} />
        <Row k="priceStale (banner)" v={String(priceStale)} bad={priceStale} />
        <Row k="last SSE message age" v={since(lastPriceTickAt, now)} bad={now - lastPriceTickAt > CONNECTION_SILENT_MS} />
        <Row k="server price age" v={priceFreshAt === null ? "unknown" : since(priceFreshAt, now)} bad={priceFreshAt !== null && now - priceFreshAt > PRICE_DELAYED_MS} />
        <Row k="last price.tick" v={`${since(feedDiag.lastTickAt, now)} (${feedDiag.lastTickSource ?? "?"})`} />
        <Row k="ticks / 10s" v={String(ticksInLast(10_000, now))} bad={ticksInLast(10_000, now) === 0} />
        <Row k="last ping" v={since(feedDiag.lastPingAt, now)} />
        <Row k="publish→send (server)" v={age(publishToSend)} />
        <Row k="send→recv (+skew)" v={age(sendToRecv)} />
      </Section>

      <Section title="STREAM">
        <Row k="streams opened" v={String(feedDiag.streamsOpened)} />
        <Row k="current streamId" v={feedDiag.currentStreamId?.slice(0, 8) ?? "—"} />
        <Row
          k="subscribed streamId"
          v={`${feedDiag.subscribedStreamId?.slice(0, 8) ?? "—"}${streamMismatch ? " ≠ current" : ""}`}
          bad={streamMismatch}
        />
        <Row k="selected pair subscribed" v={pairNotSubscribed ? "NO" : "yes"} bad={pairNotSubscribed} />
        <Row k="visibility" v={visibility} bad={visibility !== "visible"} />
        <Row k={`max timer drift (${DRIFT_WINDOW}s)`} v={age(maxDrift)} bad={maxDrift > 1_000} />
        <Row k="clock offset (srv−cli)" v={clockOffsetMs === null ? "—" : `${Math.round(clockOffsetMs)}ms ±${Math.round((rttMs ?? 0) / 2)}`} bad={clockOffsetMs !== null && Math.abs(clockOffsetMs) > 2_000} />
      </Section>

      {healthErr && <div className="mt-1.5 text-red-400">feed-health: {healthErr}</div>}

      {health && (
        <Section title="SERVER">
          <Row
            k="event loop p99 / max"
            v={health.eventLoop.lastWindow ? `${health.eventLoop.lastWindow.p99Ms} / ${health.eventLoop.lastWindow.maxMs}ms` : "—"}
            bad={(health.eventLoop.lastWindow?.maxMs ?? 0) > 1_000}
          />
          <Row k="event loop max since boot" v={`${health.eventLoop.maxSinceBootMs}ms`} />
          {Object.entries(health.feeds).map(([feed, f]) => (
            <Row
              key={feed}
              k={feed}
              v={`${age(f.newestAgeMs)} · ${f.symbols} sym · ${f.staleSymbols.length} stale`}
              bad={f.newestAgeMs === null || f.newestAgeMs > 15_000}
            />
          ))}
          <Row k="kraken→price.tick fallback" v={health.coinbase.krakenFallbackActive ? "ACTIVE" : "off"} bad={health.coinbase.krakenFallbackActive} />
          {Object.entries(health.reconnects).map(([ex, r]) => {
            const last = r.recent.at(-1);
            return (
              <Row
                key={ex}
                k={`${ex} reconnects`}
                v={`${r.total}${last ? ` · ${last.cause}${last.closeCode ? ` ${last.closeCode}` : ""} ${since(last.at, health.serverNow)} ago` : ""}`}
                bad={r.total > 0 && !!last && health.serverNow - last.at < 60_000}
              />
            );
          })}
        </Section>
      )}

      {pair && (
        <Section title={`${pair.symbol} — FILL vs SCREEN`}>
          {Object.entries(pair.feeds).map(([feed, f]) => (
            <Row key={feed} k={feed} v={f ? age(f.ageMs) : "no data"} bad={!f || f.ageMs > 10_000} />
          ))}
          <Row
            k="MARKET fill prices off"
            v={`${pair.fillPriceSource.source} @ ${pair.fillPriceSource.last}`}
            bad={pair.fillPriceSource.source !== "live"}
          />
          <Row k="kraken snapshot age" v={pair.krakenSnapshot ? age(pair.krakenSnapshot.ageMs) : "expired"} bad={!pair.krakenSnapshot || pair.krakenSnapshot.ageMs > 10_000} />
          <Row k="db last_price" v={pair.dbLastPrice ?? "—"} />
          <Row
            k="screen book bid/ask"
            v={book ? `${book.bestBid ?? "—"} / ${book.bestAsk ?? "—"} (${age(book.ageMs)})` : "—"}
            bad={!book || book.ageMs > 10_000}
          />
          <Row
            k="fill source vs book mid"
            v={fillVsBookBps === null ? "—" : `${fillVsBookBps.toFixed(1)}bps`}
            bad={fillVsBookBps !== null && Math.abs(fillVsBookBps) > 10}
          />
        </Section>
      )}
    </div>
  );
}
