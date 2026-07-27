import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { FriendRequestsList } from "@/components/messages/FriendRequestsList";
import { ConversationList } from "@/components/messages/ConversationList";
import { ConversationView } from "@/components/messages/ConversationView";
import { useChatStore } from "@/stores/chatStore";

type Tab = "chats" | "requests";

export default function MessagesPage() {
    const { conversationId } = useParams<{ conversationId?: string }>();
    const navigate = useNavigate();
    const [tab, setTab] = useState<Tab>("chats");
    const openConversation = useChatStore((s) => s.openConversation);
    const setActiveConversationId = useChatStore((s) => s.setActiveConversationId);
    const fetchMessages = useChatStore((s) => s.fetchMessages);

    // Deep-link: /messages/:conversationId activates that conversation and
    // switches to the Chats tab, once on mount / whenever the param changes
    // (e.g. clicking a different deep link while already on this page).
    useEffect(() => {
        if (!conversationId) return;
        setActiveConversationId(conversationId);
        if (!useChatStore.getState().messagesByConversation[conversationId]) {
            fetchMessages(conversationId);
        }
        setTab("chats");
    }, [conversationId, setActiveConversationId, fetchMessages]);

    // Clear "currently viewing" state whenever the Chats pane stops being
    // shown — the Requests tab is selected, or this page unmounts entirely
    // (e.g. clicking away to Trade). Without this, chatStore.activeConversationId
    // stays stuck on the last-viewed conversation, so onMessageReceived keeps
    // treating new messages as "already seen" and never increments the unread
    // badge — caught via Playwright: a message sent while genuinely navigated
    // away via the sidebar link produced no badge until this fix.
    useEffect(() => {
        if (tab !== "chats") return;
        return () => setActiveConversationId(null);
    }, [tab, setActiveConversationId]);

    async function handleMessageFriend(friendId: string, friendDisplayName: string | null) {
        const id = await openConversation(friendId, friendDisplayName);
        setTab("chats");
        navigate(`/messages/${id}`, { replace: true });
    }

    return (
        <div className="space-y-6">
            <h1 className="text-xl font-semibold">Messages</h1>

            <div className="flex gap-1 border-b border-gray-800">
                <button
                    type="button"
                    onClick={() => setTab("chats")}
                    className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                        tab === "chats" ? "border-blue-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
                    }`}
                >
                    Chats
                </button>
                <button
                    type="button"
                    onClick={() => setTab("requests")}
                    className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                        tab === "requests" ? "border-blue-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
                    }`}
                >
                    Requests
                </button>
            </div>

            {tab === "chats" ? (
                <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden flex" style={{ height: 560 }}>
                    <div className="w-64 border-r border-gray-800 overflow-y-auto flex-shrink-0">
                        <ConversationList />
                    </div>
                    <ConversationView />
                </div>
            ) : (
                <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
                    <FriendRequestsList onMessageFriend={handleMessageFriend} />
                </div>
            )}
        </div>
    );
}
