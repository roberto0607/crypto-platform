import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { cancelActiveMatch, challengeUser } from "@/api/endpoints/matches";
import { getPlayer, type PublicPlayer } from "@/api/endpoints/users";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { CopyInviteLink } from "./CopyInviteLink";
import { PlayerSearch } from "./PlayerSearch";

const DURATION_OPTIONS = [
    { value: 0.25, label: "15M" },
    { value: 1, label: "1H" },
    { value: 4, label: "4H" },
    { value: 24, label: "24H" },
    { value: 168, label: "1 WEEK" },
    { value: 336, label: "2 WEEKS" },
    { value: 504, label: "3 WEEKS" },
    { value: 672, label: "4 WEEKS" },
];

/** A match length as the challenge box shows it: 15M, 1H, … 4 WEEKS. */
export function durationLabel(hours: number): string {
    return DURATION_OPTIONS.find((d) => d.value === Number(hours))?.label ?? `${hours}H`;
}

interface ChallengeBoxProps {
    /** A challenge was sent or a stuck match cancelled: reload match state. */
    onChanged: () => void | Promise<void>;
}

/**
 * Sends a 1v1 challenge. /arena?challenge=<username> pre-fills it: that's how
 * leaderboard rows, player pages, Rematch and invite links all arrive.
 */
export function ChallengeBox({ onChanged }: ChallengeBoxProps) {
    const userId = useAuthStore((s) => s.user?.id);
    const pairs = useAppStore((s) => s.pairs);
    const [searchParams, setSearchParams] = useSearchParams();
    const prefill = searchParams.get("challenge");
    const activePairIds = pairs.filter((p) => p.is_active).map((p) => p.id);

    const [opponent, setOpponent] = useState<PublicPlayer | null>(null);
    const [duration, setDuration] = useState(24);
    const [notice, setNotice] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [matchBlocked, setMatchBlocked] = useState(false);
    const [cancelling, setCancelling] = useState(false);

    useEffect(() => {
        if (!prefill) return;
        let cancelled = false;
        setNotice(null);
        getPlayer(prefill)
            .then(({ data }) => {
                if (cancelled) return;
                if (data.player.id === userId) {
                    setNotice("This is your own invite link. Share it so others can challenge you.");
                } else {
                    setOpponent(data.player);
                }
            })
            .catch((err) => {
                if (cancelled) return;
                setNotice(err?.response?.status === 404
                    ? `Player "${prefill}" not found. Check the name, or search below.`
                    : "Couldn't load that player. Try searching below.");
            });
        return () => { cancelled = true; };
    }, [prefill, userId]);

    function clearPrefill() {
        setSearchParams((params) => {
            params.delete("challenge");
            return params;
        }, { replace: true });
    }

    function changeOpponent(player: PublicPlayer | null) {
        setOpponent(player);
        setError(null);
        setNotice(null);
        if (!player && prefill) clearPrefill();
    }

    async function handleChallenge() {
        if (!opponent) return;
        setSubmitting(true);
        setError(null);
        setMatchBlocked(false);
        try {
            await challengeUser({
                opponentId: opponent.id,
                durationHours: duration,
                allowedPairIds: activePairIds.slice(0, 3),
            });
            setOpponent(null);
            if (prefill) clearPrefill();
            await onChanged();
        } catch (err: any) {
            const code = err?.response?.data?.code;
            if (code === "match_already_active") {
                setError("You or that player already have a match in progress.");
                setMatchBlocked(true);
            } else {
                setError(err?.response?.data?.message ?? code ?? "Challenge failed");
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function handleCancelStuckMatch() {
        setCancelling(true);
        try {
            await cancelActiveMatch();
            setError(null);
            setMatchBlocked(false);
            await onChanged();
        } catch (err: any) {
            const code = err?.response?.data?.code;
            if (code === "match_has_trades") {
                setError("Match has trades — use FORFEIT instead.");
                await onChanged();
            } else {
                setError(err?.response?.data?.message ?? "Cancel failed");
            }
        } finally {
            setCancelling(false);
        }
    }

    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 9, color: "var(--ar-muted)", letterSpacing: 3, marginBottom: 8 }}>
                CHALLENGE A TRADER
            </div>
            <div className="ar-challenge-form">
                <PlayerSearch value={opponent} onChange={changeOpponent} />
                <select
                    className="ar-select"
                    aria-label="Match length"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                >
                    {DURATION_OPTIONS.map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                </select>
                <button className="ar-btn ar-btn-orange" disabled={submitting || !opponent || activePairIds.length === 0} onClick={handleChallenge}>
                    {submitting ? "..." : "CHALLENGE"}
                </button>
            </div>
            {notice && <div style={{ fontSize: 10, color: "var(--ar-gold)", marginTop: 4 }}>{notice}</div>}
            {error && <div style={{ fontSize: 10, color: "var(--ar-red)", marginTop: 4 }}>{error}</div>}
            {matchBlocked && (
                <button
                    className="ar-btn ar-btn-red"
                    style={{ marginTop: 8 }}
                    disabled={cancelling}
                    onClick={handleCancelStuckMatch}
                >
                    {cancelling ? "CANCELLING..." : "CANCEL STUCK MATCH"}
                </button>
            )}
            <CopyInviteLink />
        </div>
    );
}
