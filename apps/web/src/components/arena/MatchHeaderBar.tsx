import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import type { Match } from "@/api/endpoints/matches";
import { MatchScopeSwitch } from "@/components/trading/MatchScopeSwitch";
import { useToast } from "@/components/ToastProvider";
import { usePnlFlash } from "@/hooks/usePnlFlash";
import { formatMatchPnl } from "@/lib/matchPnl";
import { useActiveMatchStore, useMatchPnl } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";

function formatCountdown(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return "0m 0s";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    const secs = Math.floor((diff % 60_000) / 1_000);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m ${secs}s`;
}

const URGENT_MS = 30 * 60_000;

/** The last 30 minutes, or the last 10% of a match too short for that to mean anything. */
function isUrgent(match: Match): boolean {
    if (!match.ends_at) return false;
    const left = new Date(match.ends_at).getTime() - Date.now();
    return left > 0 && left < Math.min(URGENT_MS, match.duration_hours * 360_000);
}

const flashTint = (dir: string): string => (dir === "up" ? "rgba(0,255,65,0.45)" : "rgba(255,59,59,0.45)");

function PlayerScore({ name, pnl, capital, matchId, side, leading }: {
    name: string;
    pnl: string | null;
    capital: string;
    matchId: string;
    side: "you" | "opponent";
    leading: boolean;
}) {
    const n = parseFloat(pnl ?? "0");
    const flash = usePnlFlash(n, matchId, 0.01);
    return (
        <div className={`mt-h-player ${side}`}>
            <span className="mt-h-name" title={name}>{name}</span>
            <span
                key={flash.key}
                className={`mt-h-pnl${flash.dir ? " pnl-flash" : ""}`}
                style={{
                    color: n >= 0 ? "var(--ar-g)" : "var(--ar-red)",
                    background: leading ? "rgba(0,255,65,0.06)" : "rgba(204,0,0,0.06)",
                    "--pnl-flash-tint": flashTint(flash.dir),
                } as CSSProperties}
            >
                {formatMatchPnl(pnl, capital)}
            </span>
        </div>
    );
}

interface MatchHeaderBarProps {
    match: Match;
    chatOpen: boolean;
    chatUnread: number;
    onToggleChat: () => void;
}

/** The live match, on top of /trade: both players, the clock, MATCH | PRACTICE, CHAT, FORFEIT. */
export function MatchHeaderBar({ match, chatOpen, chatUnread, onToggleChat }: MatchHeaderBarProps) {
    const userId = useAuthStore((s) => s.user?.id);
    const settling = useActiveMatchStore((s) => s.settling);
    const forfeit = useActiveMatchStore((s) => s.forfeit);
    const { challengerPnlPct, opponentPnlPct } = useMatchPnl(match);
    const { addToast } = useToast();

    const [timeLeft, setTimeLeft] = useState(match.ends_at ? formatCountdown(match.ends_at) : "--");
    const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);

    useEffect(() => {
        if (!match.ends_at) return;
        const tick = () => setTimeLeft(formatCountdown(match.ends_at!));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [match.ends_at]);

    const isChallenger = match.challenger_id === userId;
    const yourName = (isChallenger ? match.challenger_name : match.opponent_name) ?? "YOU";
    const opponentName = (isChallenger ? match.opponent_name : match.challenger_name) ?? "OPPONENT";
    const yourPnl = isChallenger ? challengerPnlPct : opponentPnlPct;
    const opponentPnl = isChallenger ? opponentPnlPct : challengerPnlPct;
    const youLead = parseFloat(yourPnl ?? "0") >= parseFloat(opponentPnl ?? "0");

    const confirmForfeit = async () => {
        setShowForfeitConfirm(false);
        try {
            await forfeit(match.id);
        } catch (err: any) {
            addToast("error", err?.response?.data?.message ?? "Couldn't forfeit the match. Try again.");
        }
    };

    return (
        <>
            <div className="mt-header">
                <PlayerScore name={yourName} pnl={yourPnl} capital={match.starting_capital} matchId={match.id} side="you" leading={youLead} />

                <div className="mt-h-center">
                    <span className="mt-h-badge">1V1 LIVE</span>
                    <span className={`mt-h-timer${!settling && isUrgent(match) ? " urgent" : ""}`}>
                        {settling ? "SETTLING…" : `TIME LEFT: ${timeLeft}`}
                    </span>
                    <MatchScopeSwitch />
                </div>

                <PlayerScore name={opponentName} pnl={opponentPnl} capital={match.starting_capital} matchId={match.id} side="opponent" leading={!youLead} />

                <div className="mt-h-actions">
                    <button type="button" className={`mt-chat-toggle${chatOpen ? " active" : ""}`} onClick={onToggleChat}>
                        CHAT
                        {chatUnread > 0 && <span className="mt-chat-badge">{chatUnread > 9 ? "9+" : chatUnread}</span>}
                    </button>
                    <button type="button" className="mt-forfeit-btn" onClick={() => setShowForfeitConfirm(true)}>
                        FORFEIT
                    </button>
                </div>
            </div>

            {showForfeitConfirm && (
                <div className="mt-modal-backdrop" onClick={() => setShowForfeitConfirm(false)}>
                    <div className="mt-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="mt-modal-title">FORFEIT MATCH?</div>
                        <p className="mt-modal-text">
                            Are you sure you want to forfeit this match?
                            You will lose ELO and the match will be recorded as a loss.
                        </p>
                        <div className="mt-modal-actions">
                            <button className="ar-btn ar-btn-outline" onClick={() => setShowForfeitConfirm(false)}>
                                CANCEL
                            </button>
                            <button className="ar-btn ar-btn-red" onClick={() => { void confirmForfeit(); }}>
                                CONFIRM FORFEIT
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
