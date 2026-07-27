import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useChatStore } from "@/stores/chatStore";

// Trade-page entry point for Messages — standalone, modeled on AlertPanel.tsx's
// icon+badge+dropdown shape (same .tr-tb-icon-btn, same absolute panel, same
// outside-click-close pattern) but its own component, not a tab inside
// AlertPanel. Preview shows conversations with unread messages first, then
// pending friend requests below.
export function MessagesPanel() {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const {
        incomingRequests,
        friendsLoaded,
        fetchFriends,
        acceptFriendRequest,
        rejectFriendRequest,
        conversations,
        conversationsLoaded,
        fetchConversations,
        unreadByConversation,
        unreadTotal,
    } = useChatStore();

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        if (!friendsLoaded) fetchFriends();
        if (!conversationsLoaded) fetchConversations();
    }, [open, friendsLoaded, fetchFriends, conversationsLoaded, fetchConversations]);

    const badgeCount = incomingRequests.length + unreadTotal();
    const unreadConversations = conversations.filter((c) => (unreadByConversation[c.id] ?? 0) > 0).slice(0, 5);
    const preview = incomingRequests.slice(0, 5);

    return (
        <div ref={ref} style={{ position: "relative" }}>
            <button
                type="button"
                className="tr-tb-icon-btn"
                onClick={() => setOpen((v) => !v)}
                title="Messages"
                aria-label="Messages"
                aria-haspopup="menu"
                aria-expanded={open}
                style={{ position: "relative" }}
            >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 3.5h12v7H8.5L5 13v-2.5H2v-7z" />
                </svg>
                {badgeCount > 0 && (
                    <span style={{
                        position: "absolute", top: -3, right: -3,
                        background: "#ff3b3b", color: "#fff", fontSize: 9, fontWeight: 700,
                        borderRadius: "50%", width: 14, height: 14,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontFamily: "'Space Mono', monospace", lineHeight: 1,
                    }}>
                        {badgeCount > 9 ? "9+" : badgeCount}
                    </span>
                )}
            </button>

            {open && (
                <div style={{
                    position: "absolute", top: "100%", right: 0, marginTop: 4,
                    background: "#080808",
                    border: "1px solid rgba(0,255,65,0.16)",
                    borderRadius: 2,
                    boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
                    zIndex: 50, width: 300, padding: 0,
                    maxHeight: 420, overflow: "hidden",
                    display: "flex", flexDirection: "column",
                    fontFamily: "'Space Mono', monospace",
                }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>MESSAGES</span>
                        <button
                            type="button"
                            onClick={() => { setOpen(false); navigate("/messages"); }}
                            style={{ background: "transparent", border: "none", color: "#00ff41", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}
                        >
                            View all
                        </button>
                    </div>

                    <div style={{ overflowY: "auto" }}>
                        {unreadConversations.length > 0 && (
                            <>
                                <div style={{ padding: "8px 12px 4px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 2 }}>
                                    CONVERSATIONS
                                </div>
                                {unreadConversations.map((c) => (
                                    <button
                                        key={c.id}
                                        type="button"
                                        onClick={() => { setOpen(false); navigate(`/messages/${c.id}`); }}
                                        style={{
                                            display: "flex", alignItems: "center", justifyContent: "space-between",
                                            width: "100%", gap: 8, padding: "8px 12px",
                                            borderBottom: "1px solid rgba(255,255,255,0.05)",
                                            background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                                        }}
                                    >
                                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {c.other_display_name || "Unknown"}
                                        </span>
                                        <span style={{
                                            flexShrink: 0, background: "#ff3b3b", color: "#fff", fontSize: 9, fontWeight: 700,
                                            borderRadius: "50%", width: 14, height: 14,
                                            display: "flex", alignItems: "center", justifyContent: "center",
                                        }}>
                                            {(unreadByConversation[c.id] ?? 0) > 9 ? "9+" : unreadByConversation[c.id]}
                                        </span>
                                    </button>
                                ))}
                            </>
                        )}

                        {preview.length === 0 ? (
                            unreadConversations.length === 0 && (
                                <div style={{ padding: "16px 12px", fontSize: 10.5, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>
                                    Nothing new
                                </div>
                            )
                        ) : (
                            preview.map((f) => (
                                <div
                                    key={f.id}
                                    style={{
                                        display: "flex", alignItems: "center", justifyContent: "space-between",
                                        gap: 8, padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)",
                                    }}
                                >
                                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {f.other_display_name || "Unknown"}
                                    </span>
                                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                        <button
                                            type="button"
                                            onClick={() => acceptFriendRequest(f.id).catch(() => {})}
                                            style={{ background: "rgba(0,255,65,0.1)", border: "none", color: "#00ff41", fontSize: 9, padding: "3px 7px", cursor: "pointer", borderRadius: 2, fontFamily: "inherit" }}
                                        >
                                            Accept
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => rejectFriendRequest(f.id).catch(() => {})}
                                            style={{ background: "rgba(255,255,255,0.06)", border: "none", color: "rgba(255,255,255,0.6)", fontSize: 9, padding: "3px 7px", cursor: "pointer", borderRadius: 2, fontFamily: "inherit" }}
                                        >
                                            Reject
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
