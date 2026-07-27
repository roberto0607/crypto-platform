import { create } from "zustand";
import { useAuthStore } from "@/stores/authStore";
import {
    sendFriendRequest as apiSendFriendRequest,
    acceptFriendRequest as apiAcceptFriendRequest,
    rejectFriendRequest as apiRejectFriendRequest,
    blockUser as apiBlockUser,
    listFriends,
} from "@/api/endpoints/friends";
import {
    getOrCreateDmConversation,
    listConversations,
    listMessages as apiListMessages,
    sendMessage as apiSendMessage,
} from "@/api/endpoints/conversations";
import type {
    Friendship,
    FriendRequestReceivedEvent,
    FriendRequestAcceptedEvent,
    Conversation,
    Message,
    MessageReceivedEvent,
} from "@/types/api";

// Phase 1 slice — friendships only. Conversations/messages (Phase 2) and the
// session-only unread counters extend this same store rather than adding a
// second one, mirroring notificationStore.ts's single-store shape.
interface ChatState {
    friends: Friendship[];
    incomingRequests: Friendship[];
    outgoingRequests: Friendship[];
    friendsLoaded: boolean;

    fetchFriends: () => Promise<void>;
    sendFriendRequest: (friendId: string) => Promise<void>;
    acceptFriendRequest: (friendshipId: string) => Promise<void>;
    rejectFriendRequest: (friendshipId: string) => Promise<void>;
    blockUser: (targetId: string) => Promise<void>;

    // Called directly from useSSE.ts on push — same "store method as SSE
    // handler" pattern as notificationStore.addNotification.
    onFriendRequestReceived: (data: FriendRequestReceivedEvent) => void;
    onFriendRequestAccepted: (data: FriendRequestAcceptedEvent) => void;

    // ── Phase 2: Friends DM ──
    // Messages are stored newest-first (matches the wire order from
    // GET .../messages) so ConversationView can render with
    // flexDirection: column-reverse — zero array reversal anywhere, and the
    // browser naturally bottom-anchors scroll on the newest message.
    conversations: Conversation[];
    conversationsLoaded: boolean;
    messagesByConversation: Record<string, Message[]>;
    messageCursors: Record<string, string | null>;
    unreadByConversation: Record<string, number>;
    activeConversationId: string | null;

    fetchConversations: () => Promise<void>;
    /** Get-or-create a DM with `friendId`, set it active, load history if uncached.
     *  friendDisplayName comes from the caller (a FriendRequestRow already has it)
     *  since POST /v1/conversations/dm doesn't return joined participant info. */
    openConversation: (friendId: string, friendDisplayName: string | null) => Promise<string>;
    setActiveConversationId: (id: string | null) => void;
    fetchMessages: (conversationId: string, loadOlder?: boolean) => Promise<void>;
    sendMessage: (conversationId: string, body: string) => Promise<void>;
    unreadTotal: () => number;

    // SSE push — filters to conversationType "dm" at the call site in
    // useSSE.ts; match-chat messages never reach this store (ephemeral,
    // component-local, see MatchChatPanel in a later phase).
    onMessageReceived: (data: MessageReceivedEvent) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    friendsLoaded: false,

    async fetchFriends() {
        try {
            const { data } = await listFriends();
            set({
                friends: data.friends,
                incomingRequests: data.incomingRequests,
                outgoingRequests: data.outgoingRequests,
                friendsLoaded: true,
            });
        } catch {
            // Non-fatal — panel just shows stale/empty state, same as notificationStore.fetch
        }
    },

    async sendFriendRequest(friendId) {
        // Not caught here — callers (e.g. the send-request form) need the
        // rejection to show a real error (user_not_found, already exists, etc.),
        // same convention as AlertPanel's create-alert flow.
        const { data } = await apiSendFriendRequest(friendId);
        set((s) => ({ outgoingRequests: [data.friendship, ...s.outgoingRequests] }));
    },

    async acceptFriendRequest(friendshipId) {
        const { data } = await apiAcceptFriendRequest(friendshipId);
        set((s) => ({
            incomingRequests: s.incomingRequests.filter((f) => f.id !== friendshipId),
            friends: [data.friendship, ...s.friends],
        }));
    },

    async rejectFriendRequest(friendshipId) {
        await apiRejectFriendRequest(friendshipId);
        set((s) => ({ incomingRequests: s.incomingRequests.filter((f) => f.id !== friendshipId) }));
    },

    async blockUser(targetId) {
        await apiBlockUser(targetId);
        set((s) => ({
            friends: s.friends.filter((f) => f.other_user_id !== targetId),
            incomingRequests: s.incomingRequests.filter((f) => f.other_user_id !== targetId),
            outgoingRequests: s.outgoingRequests.filter((f) => f.other_user_id !== targetId),
        }));
    },

    onFriendRequestReceived(data) {
        const myId = useAuthStore.getState().user?.id ?? "";
        set((s) => ({
            incomingRequests: [
                {
                    id: data.friendshipId,
                    user_id: data.requesterId,
                    friend_id: myId,
                    status: "pending",
                    created_at: data.createdAt,
                    updated_at: data.createdAt,
                    other_user_id: data.requesterId,
                    other_display_name: data.requesterName,
                },
                ...s.incomingRequests,
            ],
        }));
    },

    onFriendRequestAccepted(data) {
        const myId = useAuthStore.getState().user?.id ?? "";
        const now = new Date().toISOString();
        set((s) => ({
            outgoingRequests: s.outgoingRequests.filter((f) => f.id !== data.friendshipId),
            friends: [
                {
                    id: data.friendshipId,
                    user_id: myId,
                    friend_id: data.accepterId,
                    status: "accepted",
                    created_at: now,
                    updated_at: now,
                    other_user_id: data.accepterId,
                    other_display_name: data.accepterName,
                },
                ...s.friends,
            ],
        }));
    },

    // ── Phase 2: Friends DM ──
    conversations: [],
    conversationsLoaded: false,
    messagesByConversation: {},
    messageCursors: {},
    unreadByConversation: {},
    activeConversationId: null,

    async fetchConversations() {
        try {
            const { data } = await listConversations();
            set({ conversations: data.conversations, conversationsLoaded: true });
        } catch {
            // Non-fatal
        }
    },

    async openConversation(friendId, friendDisplayName) {
        const { data } = await getOrCreateDmConversation(friendId);
        const conversation = data.conversation;
        set((s) => {
            const exists = s.conversations.some((c) => c.id === conversation.id);
            const conversations = exists
                ? s.conversations
                : [{ ...conversation, other_user_id: friendId, other_display_name: friendDisplayName }, ...s.conversations];
            return {
                conversations,
                activeConversationId: conversation.id,
                unreadByConversation: { ...s.unreadByConversation, [conversation.id]: 0 },
            };
        });
        if (!get().messagesByConversation[conversation.id]) {
            await get().fetchMessages(conversation.id);
        }
        return conversation.id;
    },

    setActiveConversationId(id) {
        set((s) => ({
            activeConversationId: id,
            unreadByConversation: id ? { ...s.unreadByConversation, [id]: 0 } : s.unreadByConversation,
        }));
    },

    async fetchMessages(conversationId, loadOlder = false) {
        const cursor = loadOlder ? get().messageCursors[conversationId] : undefined;
        if (loadOlder && !cursor) return; // no more pages
        try {
            const { data } = await apiListMessages(conversationId, cursor ? { cursor } : {});
            set((s) => ({
                messagesByConversation: {
                    ...s.messagesByConversation,
                    [conversationId]: loadOlder
                        ? [...(s.messagesByConversation[conversationId] ?? []), ...data.data]
                        : data.data,
                },
                messageCursors: { ...s.messageCursors, [conversationId]: data.nextCursor },
            }));
        } catch {
            // Non-fatal — thread just stays as-is
        }
    },

    async sendMessage(conversationId, body) {
        // Not caught — caller must surface errors (rate limit, profanity,
        // empty), same convention as sendFriendRequest.
        const { data } = await apiSendMessage(conversationId, body);
        set((s) => ({
            messagesByConversation: {
                ...s.messagesByConversation,
                [conversationId]: [data.message, ...(s.messagesByConversation[conversationId] ?? [])],
            },
            conversations: touchConversation(s.conversations, conversationId),
        }));
    },

    unreadTotal() {
        return Object.values(get().unreadByConversation).reduce((sum, n) => sum + n, 0);
    },

    onMessageReceived(data) {
        set((s) => {
            const message: Message = {
                id: data.messageId,
                conversation_id: data.conversationId,
                sender_id: data.senderId,
                body: data.body,
                image_url: data.imageUrl,
                created_at: data.createdAt,
                read_at: null,
            };

            const messagesByConversation = {
                ...s.messagesByConversation,
                [data.conversationId]: [message, ...(s.messagesByConversation[data.conversationId] ?? [])],
            };

            const isActive = s.activeConversationId === data.conversationId;
            const unreadByConversation = isActive
                ? s.unreadByConversation
                : {
                    ...s.unreadByConversation,
                    [data.conversationId]: (s.unreadByConversation[data.conversationId] ?? 0) + 1,
                };

            const exists = s.conversations.some((c) => c.id === data.conversationId);
            const conversations = exists
                ? touchConversation(s.conversations, data.conversationId)
                : [
                    {
                        id: data.conversationId,
                        type: "dm" as const,
                        context_id: null,
                        created_at: data.createdAt,
                        other_user_id: data.senderId,
                        other_display_name: data.senderName,
                    },
                    ...s.conversations,
                ];

            return { messagesByConversation, unreadByConversation, conversations };
        });
    },
}));

/** Moves the conversation with `id` to the front (most-recent-activity-first). */
function touchConversation(conversations: Conversation[], id: string): Conversation[] {
    const idx = conversations.findIndex((c) => c.id === id);
    if (idx <= 0) return conversations; // not found, or already first
    const conv = conversations[idx]!;
    return [conv, ...conversations.slice(0, idx), ...conversations.slice(idx + 1)];
}
