import { useEffect } from "react";
import { useChatStore } from "@/stores/chatStore";
import { ConversationRow } from "./ConversationRow";

export function ConversationList() {
    const {
        conversations,
        conversationsLoaded,
        unreadByConversation,
        activeConversationId,
        fetchConversations,
        setActiveConversationId,
        fetchMessages,
        messagesByConversation,
    } = useChatStore();

    useEffect(() => {
        fetchConversations();
    }, [fetchConversations]);

    function handleSelect(id: string) {
        setActiveConversationId(id);
        if (!messagesByConversation[id]) {
            fetchMessages(id);
        }
    }

    if (!conversationsLoaded) {
        return <div className="text-gray-500 text-sm text-center py-8">Loading...</div>;
    }

    if (conversations.length === 0) {
        return (
            <div className="text-gray-500 text-sm text-center py-8 px-4">
                No conversations yet. Message a friend from the Requests tab to start one.
            </div>
        );
    }

    return (
        <div>
            {conversations.map((c) => (
                <ConversationRow
                    key={c.id}
                    conversation={c}
                    unreadCount={unreadByConversation[c.id] ?? 0}
                    isActive={c.id === activeConversationId}
                    onClick={() => handleSelect(c.id)}
                />
            ))}
        </div>
    );
}
