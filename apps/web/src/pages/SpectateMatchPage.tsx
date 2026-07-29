import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getMatch, spectateMatch, unspectateMatch, type Match } from "@/api/endpoints/matches";
import { waitForStreamId } from "@/api/sse";
import type { MatchPnlUpdateEvent, MatchEndedEvent, MatchSpectatorCountEvent } from "@/types/api";

/**
 * Phase B spectator view — minimal but real: joins the match's live
 * spectator room (POST /spectate) and renders live PnL/timer/spectator-count
 * off the actual SSE events, same data participants see. No charts or match
 * chat yet — Phase C replaces this with the full split-screen view. Not a
 * static placeholder: everything rendered here is live.
 */

const PAGE_CSS = `
  .sm-wrap { padding:24px;max-width:720px;margin:0 auto;font-family:'Space Mono',monospace;color:rgba(255,255,255,0.88); }
  .sm-back { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;cursor:pointer;margin-bottom:16px;display:inline-block; }
  .sm-back:hover { color:#FF6B00; }
  .sm-card { border:1px solid rgba(255,107,0,0.3);background:rgba(255,107,0,0.04);padding:24px; }
  .sm-vs { font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:3px;text-align:center;color:#FF6B00;margin-bottom:4px; }
  .sm-timer { text-align:center;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-bottom:20px; }
  .sm-scores { display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:center;text-align:center; }
  .sm-player { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-bottom:6px; }
  .sm-pnl { font-family:'Bebas Neue',sans-serif;font-size:40px;letter-spacing:2px; }
  .sm-divider { width:1px;height:60px;background:rgba(255,255,255,0.08); }
  .sm-footer { display:flex;justify-content:space-between;align-items:center;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06); }
  .sm-watching { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px; }
  .sm-note { font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:1px;margin-top:20px;text-align:center; }
  .sm-status { text-align:center;padding:60px 20px;color:rgba(255,255,255,0.4);font-size:12px;letter-spacing:2px; }
  .sm-result { text-align:center;font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:3px;color:#FFD700;margin-bottom:16px; }
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

type LoadState = "loading" | "ready" | "denied" | "not_found" | "not_active" | "error";

export default function SpectateMatchPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [match, setMatch] = useState<Match | null>(null);
    const [state, setState] = useState<LoadState>("loading");
    const [challengerPnl, setChallengerPnl] = useState<string | null>(null);
    const [opponentPnl, setOpponentPnl] = useState<string | null>(null);
    const [spectatorCount, setSpectatorCount] = useState(0);
    const [ended, setEnded] = useState<MatchEndedEvent | null>(null);

    const streamIdRef = useRef<string | null>(null);

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
                setChallengerPnl(data.match.challenger_pnl_pct);
                setOpponentPnl(data.match.opponent_pnl_pct);

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
                <div className="sm-note">
                    Full chart view and match chat for spectators are coming in a future update — this shows live P&amp;L only for now.
                </div>
            </div>
        </>
    );
}
