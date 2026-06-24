import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
    createChart,
    CandlestickSeries,
    LineSeries,
    createSeriesMarkers,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type ISeriesMarkersPluginApi,
    type UTCTimestamp,
    type Time,
    type SeriesMarker,
} from "lightweight-charts";
import { getMatchReplay, type MatchReplay } from "@/api/endpoints/matchReplay";

const CHAL = "#FF6B00"; // challenger (war-theme orange)
const OPP = "#22D3EE"; // opponent (cyan)
const GRID = "rgba(255,255,255,0.04)";
const TEXT = "rgba(255,255,255,0.5)";

const STEP_MS = 45; // wall-clock ms per candle at 1× (≈5s for a 24h match)
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

type ErrCode = "no_replay_data" | "insufficient_candle_data" | "forbidden" | "match_not_found" | "error";

function errorMessage(code: ErrCode): { title: string; detail: string } {
    switch (code) {
        case "no_replay_data":
            return { title: "NO REPLAY AVAILABLE", detail: "This match has no recorded trade data to replay." };
        case "insufficient_candle_data":
            return { title: "NO REPLAY AVAILABLE", detail: "Price history for this match window is unavailable." };
        case "forbidden":
            return { title: "ACCESS DENIED", detail: "Only the two players can replay this match." };
        case "match_not_found":
            return { title: "MATCH NOT FOUND", detail: "This match does not exist." };
        default:
            return { title: "REPLAY UNAVAILABLE", detail: "Something went wrong loading this replay." };
    }
}

export default function MatchReplayPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [data, setData] = useState<MatchReplay | null>(null);
    const [err, setErr] = useState<ErrCode | null>(null);
    const [selectedPair, setSelectedPair] = useState<string>("");

    // Playback state
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);

    // ── Fetch ──
    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        getMatchReplay(id)
            .then((res) => {
                if (cancelled) return;
                setData(res.data);
                // Default to the most-traded pair.
                const counts: Record<string, number> = {};
                for (const p of res.data.positions) counts[p.pairSymbol] = (counts[p.pairSymbol] ?? 0) + 1;
                const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
                    ?? Object.keys(res.data.candles)[0] ?? "";
                setSelectedPair(best);
            })
            .catch((e) => {
                if (cancelled) return;
                const code = e?.response?.data?.error as ErrCode | undefined;
                const status = e?.response?.status;
                setErr(code ?? (status === 403 ? "forbidden" : status === 404 ? "match_not_found" : "error"));
            });
        return () => { cancelled = true; };
    }, [id]);

    // Canonical clock = challenger curve timestamps (same length as opponent's).
    const clock = useMemo<number[]>(() => {
        if (!data) return [];
        const c = data.curves[data.match.challenger.id] ?? [];
        return c.map((p) => p.ts);
    }, [data]);
    const N = clock.length;

    // ── Chart refs ──
    const priceElRef = useRef<HTMLDivElement>(null);
    const pnlElRef = useRef<HTMLDivElement>(null);
    const priceChartRef = useRef<IChartApi | null>(null);
    const pnlChartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    const chalLineRef = useRef<ISeriesApi<"Line"> | null>(null);
    const oppLineRef = useRef<ISeriesApi<"Line"> | null>(null);

    // Build charts once data + selectedPair are ready.
    useEffect(() => {
        if (!data || !selectedPair || !priceElRef.current || !pnlElRef.current) return;

        const common = {
            layout: { background: { color: "transparent" }, textColor: TEXT, fontSize: 10 },
            grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
            rightPriceScale: { borderColor: GRID },
            timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: false },
            handleScroll: false,
            handleScale: false,
        } as const;

        const priceChart = createChart(priceElRef.current, { ...common, height: 300 });
        const candleSeries = priceChart.addSeries(CandlestickSeries, {
            upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
            wickUpColor: "#16a34a", wickDownColor: "#dc2626",
        });
        priceChartRef.current = priceChart;
        candleSeriesRef.current = candleSeries;
        markersRef.current = createSeriesMarkers(candleSeries, []);

        const pnlChart = createChart(pnlElRef.current, { ...common, height: 200 });
        const chalLine = pnlChart.addSeries(LineSeries, { color: CHAL, lineWidth: 2, priceLineVisible: false });
        const oppLine = pnlChart.addSeries(LineSeries, { color: OPP, lineWidth: 2, priceLineVisible: false });
        chalLine.createPriceLine({ price: 0, color: "rgba(255,255,255,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
        pnlChartRef.current = pnlChart;
        chalLineRef.current = chalLine;
        oppLineRef.current = oppLine;

        const ro = new ResizeObserver(() => {
            if (priceElRef.current) priceChart.applyOptions({ width: priceElRef.current.clientWidth });
            if (pnlElRef.current) pnlChart.applyOptions({ width: pnlElRef.current.clientWidth });
        });
        ro.observe(priceElRef.current);
        ro.observe(pnlElRef.current);

        return () => {
            ro.disconnect();
            priceChart.remove();
            pnlChart.remove();
            priceChartRef.current = null;
            pnlChartRef.current = null;
        };
    }, [data, selectedPair]);

    // Render up to the current playhead index whenever it (or the pair) changes.
    useEffect(() => {
        if (!data || N === 0) return;
        const t = clock[Math.min(index, N - 1)]!;
        const pairCandles = data.candles[selectedPair] ?? [];

        // Progressive candle reveal (ts <= playhead).
        const visible = pairCandles
            .filter((cd) => cd.ts <= t)
            .map((cd) => ({ time: sec(cd.ts), open: cd.o, high: cd.h, low: cd.l, close: cd.c }));
        candleSeriesRef.current?.setData(visible);

        // Trade markers for the selected pair, revealed as the playhead reaches them.
        const markers: SeriesMarker<Time>[] = [];
        for (const p of data.positions) {
            if (p.pairSymbol !== selectedPair) continue;
            const color = p.userId === data.match.challenger.id ? CHAL : OPP;
            if (p.openedAt <= t) {
                markers.push({
                    time: sec(p.openedAt),
                    position: p.side === "LONG" ? "belowBar" : "aboveBar",
                    color,
                    shape: p.side === "LONG" ? "arrowUp" : "arrowDown",
                    text: p.side === "LONG" ? "L" : "S",
                });
            }
            if (p.closedAt != null && p.closedAt <= t) {
                markers.push({ time: sec(p.closedAt), position: "inBar", color, shape: "circle", text: "✕" });
            }
        }
        markers.sort((a, b) => (a.time as number) - (b.time as number));
        markersRef.current?.setMarkers(markers);

        // Both P&L curves draw forward to the playhead.
        const chal = data.curves[data.match.challenger.id] ?? [];
        const opp = data.curves[data.match.opponent.id] ?? [];
        chalLineRef.current?.setData(chal.slice(0, index + 1).map((p) => ({ time: sec(p.ts), value: p.pnlPct })));
        oppLineRef.current?.setData(opp.slice(0, index + 1).map((p) => ({ time: sec(p.ts), value: p.pnlPct })));

        // Keep both axes pinned to the full match window so the lines draw left→right.
        const from = sec(clock[0]!);
        const to = sec(clock[N - 1]!);
        priceChartRef.current?.timeScale().setVisibleRange({ from, to });
        pnlChartRef.current?.timeScale().setVisibleRange({ from, to });
    }, [data, index, selectedPair, clock, N]);

    // ── Animation loop ──
    const rafRef = useRef<number | null>(null);
    const lastRef = useRef<number>(0);
    const floatRef = useRef<number>(0);
    useEffect(() => {
        if (!playing || N === 0) return;
        floatRef.current = index;
        lastRef.current = 0;
        const tick = (now: number) => {
            if (lastRef.current === 0) lastRef.current = now;
            const dt = now - lastRef.current;
            lastRef.current = now;
            floatRef.current += (dt / STEP_MS) * speed;
            if (floatRef.current >= N - 1) {
                setIndex(N - 1);
                setPlaying(false);
                return;
            }
            setIndex(Math.floor(floatRef.current));
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing, speed, N]);

    // ── Render ──
    if (err) {
        const m = errorMessage(err);
        return (
            <div className="mr-wrap">
                <ReplayStyles />
                <div className="mr-empty">
                    <div className="mr-empty-title">{m.title}</div>
                    <div className="mr-empty-detail">{m.detail}</div>
                    <button className="mr-btn" onClick={() => navigate("/arena")}>← BACK TO ARENA</button>
                </div>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="mr-wrap"><ReplayStyles /><div className="mr-empty"><div className="mr-empty-detail">LOADING REPLAY…</div></div></div>
        );
    }

    const { match } = data;
    const cur = (uid: string) => data.curves[uid]?.[Math.min(index, N - 1)]?.pnlPct ?? 0;
    const winnerIs = (uid: string) =>
        (match.challenger.finalPnlPct ?? 0) === (match.opponent.finalPnlPct ?? 0)
            ? false
            : ((match.challenger.finalPnlPct ?? 0) > (match.opponent.finalPnlPct ?? 0)
                ? uid === match.challenger.id
                : uid === match.opponent.id);
    const fmt = (v: number | null | undefined) =>
        v == null ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    const pairs = Object.keys(data.candles);

    return (
        <div className="mr-wrap">
            <ReplayStyles />

            <div className="mr-header">
                <button className="mr-back" onClick={() => navigate("/arena")}>← ARENA</button>
                <div className="mr-title">POST-MATCH REPLAY</div>
                <div className="mr-date">{match.endedAt ? new Date(match.endedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : ""}</div>
            </div>

            <div className="mr-players">
                <div className="mr-player">
                    <span className="mr-dot" style={{ background: CHAL }} />
                    <span className="mr-pname" style={{ color: CHAL }}>{match.challenger.name}</span>
                    {winnerIs(match.challenger.id) && <span className="mr-crown">WINNER</span>}
                    <span className="mr-live" style={{ color: cur(match.challenger.id) >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(cur(match.challenger.id))}</span>
                    <span className="mr-final">final {fmt(match.challenger.finalPnlPct)}</span>
                </div>
                <div className="mr-vs">VS</div>
                <div className="mr-player mr-player-r">
                    <span className="mr-final">final {fmt(match.opponent.finalPnlPct)}</span>
                    <span className="mr-live" style={{ color: cur(match.opponent.id) >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(cur(match.opponent.id))}</span>
                    {winnerIs(match.opponent.id) && <span className="mr-crown">WINNER</span>}
                    <span className="mr-pname" style={{ color: OPP }}>{match.opponent.name}</span>
                    <span className="mr-dot" style={{ background: OPP }} />
                </div>
            </div>

            {pairs.length > 1 && (
                <div className="mr-pairs">
                    {pairs.map((p) => (
                        <button key={p} className={`mr-pair ${p === selectedPair ? "active" : ""}`} onClick={() => setSelectedPair(p)}>{p}</button>
                    ))}
                </div>
            )}

            <div className="mr-panel-label">PRICE — {selectedPair}</div>
            <div ref={priceElRef} className="mr-chart" />

            <div className="mr-panel-label">P&amp;L RACE</div>
            <div ref={pnlElRef} className="mr-chart" />

            <div className="mr-controls">
                <button className="mr-btn" onClick={() => { setIndex(0); floatRef.current = 0; setPlaying(false); }}>⏮ RESTART</button>
                <button className="mr-btn mr-btn-primary" onClick={() => {
                    if (index >= N - 1) { setIndex(0); floatRef.current = 0; }
                    setPlaying((p) => !p);
                }}>{playing ? "⏸ PAUSE" : "▶ PLAY"}</button>
                <input
                    className="mr-scrub"
                    type="range"
                    min={0}
                    max={Math.max(0, N - 1)}
                    value={index}
                    onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); floatRef.current = Number(e.target.value); }}
                />
                <div className="mr-speeds">
                    {[1, 2, 4].map((s) => (
                        <button key={s} className={`mr-speed ${speed === s ? "active" : ""}`} onClick={() => setSpeed(s)}>{s}×</button>
                    ))}
                </div>
                <div className="mr-time">{index + 1}/{N}</div>
            </div>
        </div>
    );
}

function ReplayStyles() {
    return (
        <style>{`
      .mr-wrap { --c:${CHAL}; --o:${OPP}; padding:16px 24px 32px; font-family:'Space Mono',monospace; color:rgba(255,255,255,0.88); }
      .mr-header { display:flex; align-items:center; gap:16px; margin-bottom:16px; }
      .mr-back, .mr-btn { background:transparent; color:var(--c); border:1px solid var(--c); padding:8px 16px; font-family:'Space Mono',monospace; font-size:10px; letter-spacing:2px; cursor:pointer; }
      .mr-btn-primary { background:var(--c); color:#000; font-weight:700; }
      .mr-title { font-family:'Bebas Neue',sans-serif; font-size:28px; letter-spacing:5px; color:var(--c); }
      .mr-date { margin-left:auto; font-size:10px; color:rgba(255,255,255,0.4); letter-spacing:2px; }
      .mr-players { display:flex; align-items:center; justify-content:center; gap:24px; margin-bottom:16px; padding:12px; border:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.02); }
      .mr-player { display:flex; align-items:center; gap:10px; flex:1; }
      .mr-player-r { justify-content:flex-end; }
      .mr-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
      .mr-pname { font-family:'Bebas Neue',sans-serif; font-size:22px; letter-spacing:2px; }
      .mr-live { font-family:'Bebas Neue',sans-serif; font-size:24px; letter-spacing:1px; }
      .mr-final { font-size:9px; color:rgba(255,255,255,0.35); letter-spacing:1px; }
      .mr-crown { font-size:8px; letter-spacing:2px; color:#FFD700; border:1px solid rgba(255,215,0,0.4); padding:2px 6px; }
      .mr-vs { font-family:'Bebas Neue',sans-serif; font-size:18px; color:rgba(255,255,255,0.3); letter-spacing:2px; }
      .mr-pairs { display:flex; gap:8px; margin-bottom:8px; }
      .mr-pair { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); color:rgba(255,255,255,0.5); padding:4px 12px; font-size:10px; letter-spacing:1px; cursor:pointer; font-family:'Space Mono',monospace; }
      .mr-pair.active { border-color:var(--c); color:var(--c); }
      .mr-panel-label { font-size:9px; color:rgba(255,255,255,0.3); letter-spacing:3px; margin:12px 0 4px; }
      .mr-chart { width:100%; border:1px solid rgba(255,255,255,0.06); }
      .mr-controls { display:flex; align-items:center; gap:12px; margin-top:14px; }
      .mr-scrub { flex:1; accent-color:var(--c); cursor:pointer; }
      .mr-speeds { display:flex; gap:4px; }
      .mr-speed { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); color:rgba(255,255,255,0.5); padding:4px 8px; font-size:10px; cursor:pointer; font-family:'Space Mono',monospace; }
      .mr-speed.active { border-color:var(--c); color:var(--c); }
      .mr-time { font-size:10px; color:rgba(255,255,255,0.4); min-width:64px; text-align:right; }
      .mr-empty { text-align:center; padding:80px 20px; }
      .mr-empty-title { font-family:'Bebas Neue',sans-serif; font-size:28px; letter-spacing:4px; color:var(--c); margin-bottom:8px; }
      .mr-empty-detail { font-size:11px; color:rgba(255,255,255,0.4); letter-spacing:1px; margin-bottom:20px; }
    `}</style>
    );
}
