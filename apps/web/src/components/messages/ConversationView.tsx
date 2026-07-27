import { useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import { useToast } from "@/components/ToastProvider";
import { reportMessage } from "@/api/endpoints/moderation";

function errMessage(err: unknown, fallback: string): string {
    const anyErr = err as { response?: { data?: { message?: string } } };
    return anyErr?.response?.data?.message ?? fallback;
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Messages render with flexDirection: column-reverse against a newest-first
// array (matches the wire order from GET .../messages and chatStore's
// storage) — zero array reversal, and the browser naturally bottom-anchors
// scroll on the newest message, same trick most chat UIs use.
export function ConversationView() {
    const { conversations, activeConversationId, messagesByConversation, messageCursors, fetchMessages, sendMessage } =
        useChatStore();
    const myId = useAuthStore((s) => s.user?.id);
    const { addToast } = useToast();
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    // Session-local — no need to persist across reload; a stale "not yet
    // reported" state after reload just means a re-report fails loudly with
    // a toast instead of showing "Reported", which is harmless.
    const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());

    async function handleReport(messageId: string) {
        if (!window.confirm("Report this message?")) return;
        try {
            await reportMessage(messageId);
            setReportedIds((prev) => new Set(prev).add(messageId));
            addToast("success", "Message reported");
        } catch (err) {
            addToast("error", errMessage(err, "Failed to report message"));
        }
    }

    const conversation = conversations.find((c) => c.id === activeConversationId);
    const messages = activeConversationId ? messagesByConversation[activeConversationId] ?? [] : [];
    const hasMore = activeConversationId ? !!messageCursors[activeConversationId] : false;

    async function handleSend() {
        const body = draft.trim();
        if (!body || !activeConversationId || sending) return;
        setSending(true);
        try {
            await sendMessage(activeConversationId, body);
            setDraft("");
        } catch (err) {
            addToast("error", errMessage(err, "Failed to send message"));
        } finally {
            setSending(false);
        }
    }

    async function handleLoadOlder() {
        if (!activeConversationId || loadingOlder) return;
        setLoadingOlder(true);
        try {
            await fetchMessages(activeConversationId, true);
        } finally {
            setLoadingOlder(false);
        }
    }

    if (!activeConversationId || !conversation) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
                Select a conversation
            </div>
        );
    }

    const name = conversation.other_display_name || "Unknown";

    return (
        <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-gray-800/50 text-sm font-medium text-white flex-shrink-0">
                {name}
            </div>

            <div className="flex-1 overflow-y-auto flex flex-col-reverse px-4 py-3 gap-2 min-h-0">
                {messages.map((m) => {
                    const mine = m.sender_id === myId;
                    return (
                        <div key={m.id} className={`max-w-[80%] flex flex-col ${mine ? "self-end items-end" : "self-start items-start"}`}>
                            <div
                                className={`rounded-lg px-3 py-2 text-sm ${
                                    mine ? "bg-blue-600/30 text-white" : "bg-gray-800 text-gray-100"
                                }`}
                            >
                                {m.body}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                                <div className="text-[10px] text-gray-500">{formatTime(m.created_at)}</div>
                                {!mine && (
                                    reportedIds.has(m.id) ? (
                                        <span className="text-[10px] text-gray-600">Reported</span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => handleReport(m.id)}
                                            className="text-[10px] text-gray-500 hover:text-red-400 hover:underline"
                                        >
                                            Report
                                        </button>
                                    )
                                )}
                            </div>
                        </div>
                    );
                })}
                {hasMore && (
                    <button
                        type="button"
                        onClick={handleLoadOlder}
                        disabled={loadingOlder}
                        className="self-center text-xs text-blue-400 hover:underline py-2 disabled:opacity-50"
                    >
                        {loadingOlder ? "Loading..." : "Load older messages"}
                    </button>
                )}
            </div>

            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-800/50 flex-shrink-0">
                <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder="Message..."
                    maxLength={2000}
                    disabled={sending}
                    className="flex-1 bg-gray-800 text-white text-sm rounded px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || !draft.trim()}
                    className="text-xs px-3 py-2 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    Send
                </button>
            </div>
        </div>
    );
}
