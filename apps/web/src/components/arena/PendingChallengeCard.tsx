import { useState } from "react";
import { cancelActiveMatch, type Match } from "@/api/endpoints/matches";
import { useToast } from "@/components/ToastProvider";

interface PendingChallengeCardProps {
    match: Match;
    userId: string;
    onAccept: () => void;
    /** The challenge is over, or may be: reload match state. */
    onClosed: () => void | Promise<void>;
}

/** A challenge waiting on an answer: ACCEPT or DECLINE, or WITHDRAW your own. */
export function PendingChallengeCard({ match, userId, onAccept, onClosed }: PendingChallengeCardProps) {
    const { addToast } = useToast();
    const [closing, setClosing] = useState(false);
    const incoming = match.opponent_id === userId;

    async function close() {
        setClosing(true);
        try {
            await cancelActiveMatch();
        } catch (err: any) {
            addToast("error", err?.response?.data?.message ?? "Couldn't update the challenge. Try again.");
        } finally {
            setClosing(false);
            await onClosed();
        }
    }

    return (
        <div className="ar-match-card">
            <div className="ar-mc-header">
                <div className="ar-mc-vs">
                    {incoming
                        ? `${match.challenger_name ?? "A TRADER"} CHALLENGED YOU`
                        : `WAITING FOR ${match.opponent_name ?? "YOUR OPPONENT"}`}
                </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                {incoming && <button className="ar-btn ar-btn-orange" onClick={onAccept}>ACCEPT</button>}
                <button className="ar-btn ar-btn-red" disabled={closing} onClick={close}>
                    {incoming ? "DECLINE" : "WITHDRAW"}
                </button>
            </div>
        </div>
    );
}
