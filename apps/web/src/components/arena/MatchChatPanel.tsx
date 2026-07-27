import { useState, useEffect, useCallback, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { listMatchChatMessages, sendMatchChatMessage } from "@/api/endpoints/matchChat";
import type { Message, MessageReceivedEvent } from "@/types/api";

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface MatchChatPanelProps {
    matchId: string;
    opponentName: string;
    isOpen: boolean;
    onClose: () => void;
}

// Ephemeral, component-local (no store) — mirrors the server side: the chat
// conversation is created when the match goes ACTIVE and hard-deleted the
// instant it ends, so there's nothing here worth persisting past this
// component's lifetime. Messages render newest-first + column-reverse, same
// trick as ConversationView.tsx.
export function MatchChatPanel({ matchId, opponentName, isOpen, onClose }: MatchChatPanelProps) {
    const myId = useAuthStore((s) => s.user?.id);
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isMounted = useRef(true);
    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    // Load history once per match — a fresh conversation exists per match, so
    // there's never a previous page worth reusing.
    useEffect(() => {
        setMessages([]);
        setError(null);
        listMatchChatMessages(matchId)
            .then(({ data }) => {
                if (isMounted.current) setMessages(data.data);
            })
            .catch(() => {
                // Non-fatal — panel just opens empty (e.g. conversation not
                // yet created, or already purged if the match just ended).
            });
    }, [matchId]);

    // MessageReceivedEvent never carries matchId (approved Gate 0 constraint)
    // — correlation relies on the one-active-match invariant: a "match"
    // conversationType push arriving while this panel is mounted can only
    // belong to the match currently on screen.
    useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MessageReceivedEvent>).detail;
            if (!d || d.conversationType !== "match" || !isMounted.current) return;
            const message: Message = {
                id: d.messageId,
                conversation_id: d.conversationId,
                sender_id: d.senderId,
                body: d.body,
                image_url: d.imageUrl,
                created_at: d.createdAt,
                read_at: null,
            };
            setMessages((prev) => [message, ...prev]);
        };
        window.addEventListener("sse:message.received", handler);
        return () => window.removeEventListener("sse:message.received", handler);
    }, []);

    const handleSend = useCallback(async () => {
        const body = draft.trim();
        if (!body || sending) return;
        setSending(true);
        setError(null);
        try {
            const { data } = await sendMatchChatMessage(matchId, body);
            if (!isMounted.current) return;
            setMessages((prev) => [data.message, ...prev]);
            setDraft("");
        } catch (err: any) {
            if (isMounted.current) {
                setError(err?.response?.data?.message ?? "Failed to send message");
            }
        } finally {
            if (isMounted.current) setSending(false);
        }
    }, [draft, sending, matchId]);

    return (
        <div className={`lmv-chat-panel${isOpen ? " open" : ""}`} aria-hidden={!isOpen}>
            <div className="lmv-chat-header">
                <span className="lmv-chat-title">CHAT — {opponentName}</span>
                <button type="button" className="lmv-chat-close" onClick={onClose} aria-label="Close chat">
                    ×
                </button>
            </div>

            <div className="lmv-chat-log">
                {messages.length === 0 ? (
                    <div className="lmv-chat-empty">No messages yet. Say hi.</div>
                ) : (
                    messages.map((m) => {
                        const mine = m.sender_id === myId;
                        return (
                            <div key={m.id} className={`lmv-chat-msg${mine ? " mine" : ""}`}>
                                <div className="lmv-chat-bubble">{m.body}</div>
                                <div className="lmv-chat-ts">{formatTime(m.created_at)}</div>
                            </div>
                        );
                    })
                )}
            </div>

            {error && <div className="lmv-chat-error">{error}</div>}

            <div className="lmv-chat-input-row">
                <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void handleSend();
                        }
                    }}
                    placeholder="Message..."
                    maxLength={2000}
                    disabled={sending}
                    className="lmv-chat-input"
                />
                <button
                    type="button"
                    className="lmv-chat-send"
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim()}
                >
                    SEND
                </button>
            </div>
        </div>
    );
}
