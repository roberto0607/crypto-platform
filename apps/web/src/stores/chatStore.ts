import { create } from "zustand";
import { useAuthStore } from "@/stores/authStore";
import {
    sendFriendRequest as apiSendFriendRequest,
    acceptFriendRequest as apiAcceptFriendRequest,
    rejectFriendRequest as apiRejectFriendRequest,
    blockUser as apiBlockUser,
    listFriends,
} from "@/api/endpoints/friends";
import type { Friendship, FriendRequestReceivedEvent, FriendRequestAcceptedEvent } from "@/types/api";

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
}

export const useChatStore = create<ChatState>((set) => ({
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
}));
