import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { acceptMatch, cancelActiveMatch } from "@/api/endpoints/matches";
import { useToast } from "@/components/ToastProvider";
import { durationLabel } from "@/components/arena/ChallengeBox";
import { useAuthStore } from "@/stores/authStore";
import {
    acquireActiveMatchPolling,
    releaseActiveMatchPolling,
    useActiveMatchStore,
} from "@/stores/activeMatchStore";

const usd = (amount: string) =>
    `$${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const button = (color: string, filled: boolean): React.CSSProperties => ({
    padding: "6px 14px", fontFamily: "inherit", fontSize: 10, fontWeight: 700, letterSpacing: 2,
    cursor: "pointer", border: `1px solid ${color}`,
    color: filled ? "#000" : color, background: filled ? color : "transparent",
});

/**
 * A pending 1v1, on every page: the receiver gets ACCEPT / DECLINE, the sender
 * WAITING FOR + WITHDRAW. It lives in the page flow under the header, not over
 * it, so it never covers the chart or the order panel. The shared match store
 * drives it (challenge.received / challenge.closed / match.started, the poll),
 * and this card keeps that store listening on every page.
 */
export function ChallengeCard() {
    const userId = useAuthStore((s) => s.user?.id);
    const match = useActiveMatchStore((s) => s.activeMatch);
    const refreshMatch = useActiveMatchStore((s) => s.refreshMatch);
    const navigate = useNavigate();
    const { addToast } = useToast();
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!userId) return;
        acquireActiveMatchPolling();
        void refreshMatch();
        return () => releaseActiveMatchPolling();
    }, [userId, refreshMatch]);

    if (!userId || match?.status !== "PENDING") return null;
    const incoming = match.opponent_id === userId;
    if (!incoming && match.challenger_id !== userId) return null;

    async function accept() {
        setBusy(true);
        try {
            await acceptMatch(match!.id);
            await refreshMatch();
            navigate("/trade");
        } catch (err: any) {
            addToast("error", err?.response?.data?.message ?? "Couldn't accept the match. Try again.");
            await refreshMatch();
        } finally {
            setBusy(false);
        }
    }

    async function close() {
        setBusy(true);
        try {
            await cancelActiveMatch();
        } catch (err: any) {
            addToast("error", err?.response?.data?.message ?? "Couldn't update the challenge. Try again.");
        } finally {
            await refreshMatch();
            setBusy(false);
        }
    }

    const name = incoming ? match.challenger_name ?? "A TRADER" : match.opponent_name ?? "YOUR OPPONENT";

    return (
        <div
            data-testid="challenge-card"
            role="status"
            className="relative z-20 font-mono"
            style={{
                display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "8px 16px",
                padding: "8px 16px", background: "rgba(255,107,0,0.12)", borderBottom: "1px solid rgba(255,107,0,0.5)",
                color: "#fff", fontSize: 11, letterSpacing: 2,
            }}
        >
            <span style={{ color: "#FF6B00", fontWeight: 700 }}>
                {incoming ? `⚔️ CHALLENGE FROM ${name}` : `WAITING FOR ${name}`}
            </span>
            <span style={{ color: "rgba(255,255,255,0.6)" }}>
                {durationLabel(match.duration_hours)} · {usd(match.starting_capital)} STARTING CAPITAL
            </span>
            <span style={{ display: "flex", gap: 8 }}>
                {incoming && (
                    <button type="button" disabled={busy} onClick={() => { void accept(); }} style={button("#FF6B00", true)}>
                        ACCEPT
                    </button>
                )}
                <button type="button" disabled={busy} onClick={() => { void close(); }} style={button("#ff3b3b", false)}>
                    {incoming ? "DECLINE" : "WITHDRAW"}
                </button>
            </span>
        </div>
    );
}
