import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
    createChart,
    CandlestickSeries,
    LineSeries,
    LineStyle,
    type ISeriesApi,
    type UTCTimestamp,
} from "lightweight-charts";
import { getMatch, spectateMatch, unspectateMatch, type Match } from "@/api/endpoints/matches";
import { listMatchChatMessages } from "@/api/endpoints/matchChat";
import { waitForStreamId } from "@/api/sse";
import { createDatafeedAdapter } from "@/lib/datafeedAdapter";
import { useAppStore } from "@/stores/appStore";
import type {
    MatchPnlUpdateEvent,
    MatchEndedEvent,
    MatchSpectatorCountEvent,
    MessageReceivedEvent,
    Message,
} from "@/types/api";

/**
 * Phase C spectator view — full parity with what the two participants see:
 * a live chart (participants themselves only ever see ONE shared chart for
 * whichever pair they've selected — there's no per-player chart pane to
 * mirror, see Gate 0 recon), a live dual-line P&L race (same visual language
 * as the Stage 6 post-match replay: challenger orange / opponent cyan, 0%
 * baseline), read-only match chat, and the live spectator count from
 * Phase A/B.
 *
 * The candlestick chart is a STANDALONE lightweight-charts instance (not the
 * shared <CandlestickChart> component) — that component reads/writes a
 * single app-wide Zustand store (useTradingStore.selectedPairId), so
 * embedding it here would mean a spectator's pair choice silently changes
 * whatever pair they have open on /trade in the same tab, and vice versa.
 * MatchReplayPage.tsx already established this "build our own chart off the
 * datafeed adapter" pattern for exactly this reason; this reuses it, live
 * instead of replayed.
 */

const CHAL = "#FF6B00";
const OPP = "#22D3EE";
const TIMEFRAME = "5m" as const;
const GRID = "rgba(255,255,255,0.06)";
const TEXT = "rgba(255,255,255,0.5)";

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

const PAGE_CSS = `
  .sm-wrap { padding:24px;max-width:960px;margin:0 auto;font-family:'Space Mono',monospace;color:rgba(255,255,255,0.88); }
  .sm-back { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;cursor:pointer;margin-bottom:16px;display:inline-block; }
  .sm-back:hover { color:#FF6B00; }
  .sm-card { border:1px solid rgba(255,107,0,0.3);background:rgba(255,107,0,0.04);padding:20px;margin-bottom:16px; }
  .sm-vs { font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:3px;text-align:center;color:#FF6B00;margin-bottom:4px; }
  .sm-timer { text-align:center;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-bottom:16px; }
  .sm-scores { display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:center;text-align:center; }
  .sm-player { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-bottom:6px; }
  .sm-pnl { font-family:'Bebas Neue',sans-serif;font-size:32px;letter-spacing:2px; }
  .sm-divider { width:1px;height:50px;background:rgba(255,255,255,0.08); }
  .sm-footer { display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06); }
  .sm-watching { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px; }
  .sm-status { text-align:center;padding:60px 20px;color:rgba(255,255,255,0.4);font-size:12px;letter-spacing:2px; }
  .sm-result { text-align:center;font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:3px;color:#FFD700;margin-bottom:16px; }
  .sm-section-label { font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:3px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center; }
  .sm-pair-select { background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#fff;font-family:'Space Mono',monospace;font-size:10px;letter-spacing:1px;padding:4px 8px;cursor:pointer; }
  .sm-chart { width:100%;height:280px; }
  .sm-pnl-chart { width:100%;height:160px; }
  .sm-chat-log { max-height:220px;overflow-y:auto;display:flex;flex-direction:column-reverse;gap:8px;padding:4px 2px; }
  .sm-chat-empty { text-align:center;color:rgba(255,255,255,0.3);font-size:10px;letter-spacing:1px;padding:20px 0; }
  .sm-chat-msg { display:flex;flex-direction:column;max-width:70%; }
  .sm-chat-msg.chal { align-self:flex-start; }
  .sm-chat-msg.opp { align-self:flex-end;align-items:flex-end; }
  .sm-chat-bubble { background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);padding:6px 10px;font-size:11px;border-radius:2px; }
  .sm-chat-msg.chal .sm-chat-bubble { border-color:rgba(255,107,0,0.3); }
  .sm-chat-msg.opp .sm-chat-bubble { border-color:rgba(34,211,238,0.3); }
  .sm-chat-meta { font-size:9px;color:rgba(255,255,255,0.3);letter-spacing:1px;margin-top:2px; }
  .sm-note { font-size:9px;color:rgba(255,255,255,0.25);letter-spacing:1px;margin-top:4px;text-align:center; }
`;

function formatPnl(pct: string | null): string {
    if (!pct) return "0.00%";
    const n = parseFloat(pct);
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function formatTimeRemaining(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return "ENDED";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}D ${hours}H`;
    if (hours > 0) return `${hours}H ${mins}M`;
    return `${mins}M`;
}

function formatChatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type LoadState = "loading" | "ready" | "denied" | "not_found" | "not_active" | "error";

export default function SpectateMatchPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const pairs = useAppStore((s) => s.pairs);

    const [match, setMatch] = useState<Match | null>(null);
    const [state, setState] = useState<LoadState>("loading");
    const [challengerPnl, setChallengerPnl] = useState<string | null>("0");
    const [opponentPnl, setOpponentPnl] = useState<string | null>("0");
    const [spectatorCount, setSpectatorCount] = useState(0);
    const [ended, setEnded] = useState<MatchEndedEvent | null>(null);
    const [selectedPairId, setSelectedPairId] = useState<string>("");
    const [messages, setMessages] = useState<Message[]>([]);

    const streamIdRef = useRef<string | null>(null);
    const chartElRef = useRef<HTMLDivElement | null>(null);
    const pnlElRef = useRef<HTMLDivElement | null>(null);
    const datafeedRef = useRef(createDatafeedAdapter());

    // Fetch the match and, for a non-participant, join its spectator room.
    useEffect(() => {
        if (!id) return;
        let cancelled = false;

        (async () => {
            try {
                const { data } = await getMatch(id);
                if (cancelled) return;
                if (data.match.status !== "ACTIVE") {
                    setState("not_active");
                    return;
                }
                setMatch(data.match);
                setChallengerPnl(data.match.challenger_pnl_pct ?? "0");
                setOpponentPnl(data.match.opponent_pnl_pct ?? "0");

                if (data.viewerRole === "spectator") {
                    const streamId = await waitForStreamId();
                    if (cancelled) return;
                    const spec = await spectateMatch(id, streamId);
                    if (cancelled) return;
                    streamIdRef.current = streamId;
                    setSpectatorCount(spec.data.spectatorCount);
                }
                setState("ready");
            } catch (err: any) {
                if (cancelled) return;
                const code = err?.response?.data?.code;
                if (code === "forbidden") setState("denied");
                else if (code === "match_not_found") setState("not_found");
                else if (code === "match_not_active") setState("not_active");
                else setState("error");
            }
        })();

        return () => {
            cancelled = true;
            if (id && streamIdRef.current) {
                unspectateMatch(id, streamIdRef.current).catch(() => { /* best-effort */ });
            }
        };
    }, [id]);

    // Default the chart's pair once the platform pair list is available.
    useEffect(() => {
        if (selectedPairId || pairs.length === 0) return;
        const active = pairs.find((p) => p.is_active);
        if (active) setSelectedPairId(active.id);
    }, [pairs, selectedPairId]);

    // Chat history — loaded once the viewer is authorized.
    useEffect(() => {
        if (!id || state !== "ready") return;
        listMatchChatMessages(id)
            .then(({ data }) => setMessages(data.data))
            .catch(() => { /* non-fatal — panel just opens empty */ });
    }, [id, state]);

    // Live chat — same window-CustomEvent pattern MatchChatPanel uses.
    useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MessageReceivedEvent>).detail;
            if (!d || d.conversationType !== "match") return;
            setMessages((prev) => [{
                id: d.messageId,
                conversation_id: d.conversationId,
                sender_id: d.senderId,
                body: d.body,
                image_url: d.imageUrl,
                created_at: d.createdAt,
                read_at: null,
            }, ...prev]);
        };
        window.addEventListener("sse:message.received", handler);
        return () => window.removeEventListener("sse:message.received", handler);
    }, []);

    // Live PnL updates.
    useEffect(() => {
        if (!id) return;
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MatchPnlUpdateEvent>).detail;
            if (d.matchId !== id) return;
            setChallengerPnl(d.challengerPnlPct);
            setOpponentPnl(d.opponentPnlPct);
        };
        window.addEventListener("sse:match.pnl.update", handler);
        return () => window.removeEventListener("sse:match.pnl.update", handler);
    }, [id]);

    // Live spectator count.
    useEffect(() => {
        if (!id) return;
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MatchSpectatorCountEvent>).detail;
            if (d.matchId !== id) return;
            setSpectatorCount(d.count);
        };
        window.addEventListener("sse:match.spectator_count", handler);
        return () => window.removeEventListener("sse:match.spectator_count", handler);
    }, [id]);

    // Match end — show the final result instead of erroring out.
    useEffect(() => {
        if (!id) return;
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MatchEndedEvent>).detail;
            if (d.matchId !== id) return;
            setEnded(d);
            setChallengerPnl(d.challengerPnlPct);
            setOpponentPnl(d.opponentPnlPct);
        };
        window.addEventListener("sse:match.ended", handler);
        return () => window.removeEventListener("sse:match.ended", handler);
    }, [id]);

    // Live candlestick chart — standalone lightweight-charts instance fed by
    // the same datafeed adapter CandlestickChart.tsx uses, but with a
    // page-local pairId instead of the shared trading store (see file header).
    useEffect(() => {
        if (!chartElRef.current || !selectedPairId || state !== "ready") return;

        const chart = createChart(chartElRef.current, {
            layout: { background: { color: "transparent" }, textColor: TEXT, fontSize: 10 },
            grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
            rightPriceScale: { borderColor: GRID },
            timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: false },
        });
        const series = chart.addSeries(CandlestickSeries, {
            upColor: "#00ff41", downColor: "#ff3b3b", borderVisible: false,
            wickUpColor: "#00ff41", wickDownColor: "#ff3b3b",
        });

        let cancelled = false;
        let liveCandle: { time: UTCTimestamp; open: number; high: number; low: number; close: number } | null = null;

        datafeedRef.current.getBars(selectedPairId, TIMEFRAME, { limit: 300 }).then((candles) => {
            if (cancelled || !candles) return;
            series.setData(candles.map((c) => ({
                time: sec(new Date(c.ts).getTime()),
                open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close),
            })));
            chart.timeScale().fitContent();
        });

        const handle = datafeedRef.current.subscribeBars(
            selectedPairId,
            TIMEFRAME,
            (tick) => {
                const price = parseFloat(tick.last);
                const bucketed = (Math.floor(Date.now() / 1000 / 300) * 300) as UTCTimestamp;
                if (liveCandle && liveCandle.time === bucketed) {
                    liveCandle.high = Math.max(liveCandle.high, price);
                    liveCandle.low = Math.min(liveCandle.low, price);
                    liveCandle.close = price;
                } else {
                    liveCandle = { time: bucketed, open: price, high: price, low: price, close: price };
                }
                series.update(liveCandle);
            },
            (candle) => {
                series.update({
                    time: sec(candle.ts),
                    open: parseFloat(candle.open), high: parseFloat(candle.high), low: parseFloat(candle.low), close: parseFloat(candle.close),
                });
                liveCandle = null;
            },
        );

        const ro = new ResizeObserver(() => {
            if (chartElRef.current) chart.applyOptions({ width: chartElRef.current.clientWidth });
        });
        ro.observe(chartElRef.current);

        return () => {
            cancelled = true;
            ro.disconnect();
            datafeedRef.current.unsubscribeBars(handle);
            chart.remove();
        };
    }, [selectedPairId, state]);

    // Live P&L race — dual line chart, same visual language as the Stage 6
    // post-match replay (challenger orange / opponent cyan, 0% baseline).
    const chalLineRef = useRef<ISeriesApi<"Line"> | null>(null);
    const oppLineRef = useRef<ISeriesApi<"Line"> | null>(null);
    useEffect(() => {
        if (!pnlElRef.current || state !== "ready") return;

        const chart = createChart(pnlElRef.current, {
            layout: { background: { color: "transparent" }, textColor: TEXT, fontSize: 10 },
            grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
            rightPriceScale: { borderColor: GRID },
            timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: false },
        });
        const chalLine = chart.addSeries(LineSeries, { color: CHAL, lineWidth: 2, priceLineVisible: false });
        const oppLine = chart.addSeries(LineSeries, { color: OPP, lineWidth: 2, priceLineVisible: false });
        chalLine.createPriceLine({ price: 0, color: "rgba(255,255,255,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
        chalLineRef.current = chalLine;
        oppLineRef.current = oppLine;

        const t = sec(Date.now());
        chalLine.update({ time: t, value: parseFloat(challengerPnl ?? "0") });
        oppLine.update({ time: t, value: parseFloat(opponentPnl ?? "0") });

        const ro = new ResizeObserver(() => {
            if (pnlElRef.current) chart.applyOptions({ width: pnlElRef.current.clientWidth });
        });
        ro.observe(pnlElRef.current);

        return () => {
            ro.disconnect();
            chart.remove();
            chalLineRef.current = null;
            oppLineRef.current = null;
        };
        // Seeded once on mount — subsequent points are appended by the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);

    useEffect(() => {
        if (!chalLineRef.current || !oppLineRef.current) return;
        const t = sec(Date.now());
        chalLineRef.current.update({ time: t, value: parseFloat(challengerPnl ?? "0") });
        oppLineRef.current.update({ time: t, value: parseFloat(opponentPnl ?? "0") });
    }, [challengerPnl, opponentPnl]);

    if (state === "loading") {
        return (
            <>
                <style>{PAGE_CSS}</style>
                <div className="sm-wrap"><div className="sm-status">LOADING MATCH...</div></div>
            </>
        );
    }

    if (state === "denied" || state === "not_found" || state === "not_active" || state === "error") {
        const message = state === "denied"
            ? "You don't have access to this match."
            : state === "not_found"
                ? "This match doesn't exist."
                : state === "not_active"
                    ? "This match isn't live right now."
                    : "Something went wrong loading this match.";
        return (
            <>
                <style>{PAGE_CSS}</style>
                <div className="sm-wrap">
                    <div className="sm-back" onClick={() => navigate("/arena")}>&larr; BACK TO ARENA</div>
                    <div className="sm-status">{message}</div>
                </div>
            </>
        );
    }

    if (!match) return null;

    const activePairs = pairs.filter((p) => p.is_active);

    return (
        <>
            <style>{PAGE_CSS}</style>
            <div className="sm-wrap">
                <div className="sm-back" onClick={() => navigate("/arena")}>&larr; BACK TO ARENA</div>

                <div className="sm-card">
                    {ended && (
                        <div className="sm-result">
                            {ended.winnerUserId
                                ? `${ended.winnerUserId === match.challenger_id ? match.challenger_name : match.opponent_name} WON`
                                : "MATCH ENDED"}
                        </div>
                    )}
                    <div className="sm-vs">
                        {match.challenger_name ?? "CHALLENGER"} <span style={{ color: "rgba(255,255,255,0.3)" }}>VS</span> {match.opponent_name ?? "OPPONENT"}
                    </div>
                    <div className="sm-timer">
                        {ended ? "FINAL" : match.ends_at ? formatTimeRemaining(match.ends_at) : ""}
                    </div>
                    <div className="sm-scores">
                        <div>
                            <div className="sm-player">{match.challenger_name ?? "CHALLENGER"} ({match.challenger_elo})</div>
                            <div className="sm-pnl" style={{ color: parseFloat(challengerPnl ?? "0") >= 0 ? "#00ff41" : "#ff3b3b" }}>
                                {formatPnl(challengerPnl)}
                            </div>
                        </div>
                        <div className="sm-divider" />
                        <div>
                            <div className="sm-player">{match.opponent_name ?? "OPPONENT"} ({match.opponent_elo})</div>
                            <div className="sm-pnl" style={{ color: parseFloat(opponentPnl ?? "0") >= 0 ? "#00ff41" : "#ff3b3b" }}>
                                {formatPnl(opponentPnl)}
                            </div>
                        </div>
                    </div>
                    <div className="sm-footer">
                        <div className="sm-watching">● {spectatorCount} WATCHING</div>
                    </div>
                </div>

                <div className="sm-card">
                    <div className="sm-section-label">
                        <span>LIVE CHART</span>
                        {activePairs.length > 0 && (
                            <select
                                className="sm-pair-select"
                                value={selectedPairId}
                                onChange={(e) => setSelectedPairId(e.target.value)}
                            >
                                {activePairs.map((p) => (
                                    <option key={p.id} value={p.id}>{p.symbol}</option>
                                ))}
                            </select>
                        )}
                    </div>
                    <div ref={chartElRef} className="sm-chart" />
                </div>

                <div className="sm-card">
                    <div className="sm-section-label"><span>P&amp;L RACE</span></div>
                    <div ref={pnlElRef} className="sm-pnl-chart" />
                </div>

                <div className="sm-card">
                    <div className="sm-section-label"><span>MATCH CHAT</span></div>
                    <div className="sm-chat-log">
                        {messages.length === 0 ? (
                            <div className="sm-chat-empty">No messages yet.</div>
                        ) : (
                            messages.map((m) => {
                                const side = m.sender_id === match.challenger_id ? "chal" : "opp";
                                return (
                                    <div key={m.id} className={`sm-chat-msg ${side}`}>
                                        <div className="sm-chat-bubble">{m.body}</div>
                                        <div className="sm-chat-meta">{formatChatTime(m.created_at)}</div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                    <div className="sm-note">Spectating is read-only — only the two players can chat.</div>
                </div>
            </div>
        </>
    );
}
