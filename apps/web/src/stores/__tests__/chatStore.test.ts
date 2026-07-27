import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Friendship, Conversation, Message } from "@/types/api";

const sendFriendRequestApi = vi.fn();
const acceptFriendRequestApi = vi.fn();
const rejectFriendRequestApi = vi.fn();
const blockUserApi = vi.fn();
const listFriendsApi = vi.fn();

vi.mock("@/api/endpoints/friends", () => ({
    sendFriendRequest: (friendId: string) => sendFriendRequestApi(friendId),
    acceptFriendRequest: (id: string) => acceptFriendRequestApi(id),
    rejectFriendRequest: (id: string) => rejectFriendRequestApi(id),
    blockUser: (id: string) => blockUserApi(id),
    listFriends: () => listFriendsApi(),
}));

const getOrCreateDmConversationApi = vi.fn();
const listConversationsApi = vi.fn();
const listMessagesApi = vi.fn();
const sendMessageApi = vi.fn();

vi.mock("@/api/endpoints/conversations", () => ({
    getOrCreateDmConversation: (friendId: string) => getOrCreateDmConversationApi(friendId),
    listConversations: () => listConversationsApi(),
    listMessages: (id: string, params: unknown) => listMessagesApi(id, params),
    sendMessage: (id: string, body: string) => sendMessageApi(id, body),
}));

import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";

function friendship(overrides: Partial<Friendship> = {}): Friendship {
    return {
        id: "f1",
        user_id: "me",
        friend_id: "them",
        status: "pending",
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
        other_user_id: "them",
        other_display_name: "Bob",
        ...overrides,
    };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
    return {
        id: "c1",
        type: "dm",
        context_id: null,
        created_at: "2026-07-01T00:00:00Z",
        other_user_id: "them",
        other_display_name: "Bob",
        ...overrides,
    };
}

function message(overrides: Partial<Message> = {}): Message {
    return {
        id: "m1",
        conversation_id: "c1",
        sender_id: "them",
        body: "hi",
        image_url: null,
        created_at: "2026-07-01T00:00:00Z",
        read_at: null,
        ...overrides,
    };
}

beforeEach(() => {
    sendFriendRequestApi.mockReset();
    acceptFriendRequestApi.mockReset();
    rejectFriendRequestApi.mockReset();
    blockUserApi.mockReset();
    listFriendsApi.mockReset();
    getOrCreateDmConversationApi.mockReset();
    listConversationsApi.mockReset();
    listMessagesApi.mockReset();
    sendMessageApi.mockReset();
    useChatStore.setState({
        friends: [],
        incomingRequests: [],
        outgoingRequests: [],
        friendsLoaded: false,
        conversations: [],
        conversationsLoaded: false,
        messagesByConversation: {},
        messageCursors: {},
        unreadByConversation: {},
        activeConversationId: null,
    });
    useAuthStore.setState({ user: { id: "me", email: "me@test.com", role: "USER" } });
});

describe("chatStore.fetchFriends", () => {
    it("populates friends/incoming/outgoing and sets friendsLoaded on success", async () => {
        listFriendsApi.mockResolvedValue({
            data: {
                ok: true,
                friends: [friendship({ id: "f-friend", status: "accepted" })],
                incomingRequests: [friendship({ id: "f-in" })],
                outgoingRequests: [friendship({ id: "f-out" })],
            },
        });

        await useChatStore.getState().fetchFriends();

        const s = useChatStore.getState();
        expect(s.friends).toHaveLength(1);
        expect(s.incomingRequests).toHaveLength(1);
        expect(s.outgoingRequests).toHaveLength(1);
        expect(s.friendsLoaded).toBe(true);
    });

    it("swallows failure — non-fatal, matches notificationStore.fetch()", async () => {
        listFriendsApi.mockRejectedValue(new Error("network"));
        await expect(useChatStore.getState().fetchFriends()).resolves.toBeUndefined();
        expect(useChatStore.getState().friendsLoaded).toBe(false);
    });
});

describe("chatStore.sendFriendRequest", () => {
    it("prepends the new friendship to outgoingRequests", async () => {
        const created = friendship({ id: "new-req", status: "pending" });
        sendFriendRequestApi.mockResolvedValue({ data: { ok: true, friendship: created } });

        await useChatStore.getState().sendFriendRequest("them");

        expect(useChatStore.getState().outgoingRequests[0]).toEqual(created);
    });

    it("propagates the error (caller must surface it, e.g. via toast)", async () => {
        sendFriendRequestApi.mockRejectedValue(new Error("already exists"));
        await expect(useChatStore.getState().sendFriendRequest("them")).rejects.toThrow("already exists");
    });
});

describe("chatStore.acceptFriendRequest", () => {
    it("moves the friendship from incomingRequests to friends", async () => {
        useChatStore.setState({ incomingRequests: [friendship({ id: "f1" })] });
        const accepted = friendship({ id: "f1", status: "accepted" });
        acceptFriendRequestApi.mockResolvedValue({ data: { ok: true, friendship: accepted } });

        await useChatStore.getState().acceptFriendRequest("f1");

        const s = useChatStore.getState();
        expect(s.incomingRequests).toHaveLength(0);
        expect(s.friends).toEqual([accepted]);
    });
});

describe("chatStore.rejectFriendRequest", () => {
    it("removes the friendship from incomingRequests", async () => {
        useChatStore.setState({ incomingRequests: [friendship({ id: "f1" }), friendship({ id: "f2" })] });
        rejectFriendRequestApi.mockResolvedValue({ data: { ok: true } });

        await useChatStore.getState().rejectFriendRequest("f1");

        expect(useChatStore.getState().incomingRequests.map((f) => f.id)).toEqual(["f2"]);
    });
});

describe("chatStore.blockUser", () => {
    it("removes the target from friends, incoming, and outgoing", async () => {
        useChatStore.setState({
            friends: [friendship({ id: "a", other_user_id: "target" }), friendship({ id: "b", other_user_id: "keep" })],
            incomingRequests: [friendship({ id: "c", other_user_id: "target" })],
            outgoingRequests: [friendship({ id: "d", other_user_id: "target" })],
        });
        blockUserApi.mockResolvedValue({ data: { ok: true, friendship: friendship({ status: "blocked" }) } });

        await useChatStore.getState().blockUser("target");

        const s = useChatStore.getState();
        expect(s.friends).toHaveLength(1);
        expect(s.friends[0]!.id).toBe("b");
        expect(s.incomingRequests).toHaveLength(0);
        expect(s.outgoingRequests).toHaveLength(0);
    });
});

describe("chatStore SSE push handlers", () => {
    it("onFriendRequestReceived prepends to incomingRequests", () => {
        useChatStore.getState().onFriendRequestReceived({
            friendshipId: "f-new",
            requesterId: "requester-1",
            requesterName: "Alice",
            createdAt: "2026-07-26T00:00:00Z",
        });

        const row = useChatStore.getState().incomingRequests[0]!;
        expect(row.id).toBe("f-new");
        expect(row.other_user_id).toBe("requester-1");
        expect(row.other_display_name).toBe("Alice");
        expect(row.status).toBe("pending");
        expect(row.friend_id).toBe("me"); // from useAuthStore
    });

    it("onFriendRequestAccepted removes the outgoing request and adds to friends", () => {
        useChatStore.setState({ outgoingRequests: [friendship({ id: "f-out" })] });

        useChatStore.getState().onFriendRequestAccepted({
            friendshipId: "f-out",
            accepterId: "accepter-1",
            accepterName: "Carol",
        });

        const s = useChatStore.getState();
        expect(s.outgoingRequests).toHaveLength(0);
        expect(s.friends[0]!.id).toBe("f-out");
        expect(s.friends[0]!.other_display_name).toBe("Carol");
        expect(s.friends[0]!.status).toBe("accepted");
    });
});

describe("chatStore.fetchConversations", () => {
    it("populates conversations and sets conversationsLoaded", async () => {
        listConversationsApi.mockResolvedValue({ data: { ok: true, conversations: [conversation()] } });
        await useChatStore.getState().fetchConversations();
        const s = useChatStore.getState();
        expect(s.conversations).toHaveLength(1);
        expect(s.conversationsLoaded).toBe(true);
    });

    it("swallows failure — non-fatal", async () => {
        listConversationsApi.mockRejectedValue(new Error("network"));
        await expect(useChatStore.getState().fetchConversations()).resolves.toBeUndefined();
        expect(useChatStore.getState().conversationsLoaded).toBe(false);
    });
});

describe("chatStore.openConversation", () => {
    it("adds a new conversation, sets it active, clears its unread, and loads history", async () => {
        getOrCreateDmConversationApi.mockResolvedValue({
            data: { ok: true, conversation: { id: "c-new", type: "dm", context_id: null, created_at: "2026-07-01T00:00:00Z" } },
        });
        listMessagesApi.mockResolvedValue({ data: { ok: true, data: [message({ id: "m1" })], nextCursor: null } });
        useChatStore.setState({ unreadByConversation: { "c-new": 3 } });

        const id = await useChatStore.getState().openConversation("them", "Bob");

        expect(id).toBe("c-new");
        const s = useChatStore.getState();
        expect(s.activeConversationId).toBe("c-new");
        expect(s.conversations[0]!.id).toBe("c-new");
        expect(s.conversations[0]!.other_display_name).toBe("Bob");
        expect(s.unreadByConversation["c-new"]).toBe(0);
        expect(s.messagesByConversation["c-new"]).toHaveLength(1);
    });

    it("reuses an existing conversation without duplicating it in the list", async () => {
        useChatStore.setState({
            conversations: [conversation({ id: "c1" })],
            messagesByConversation: { c1: [message()] },
        });
        getOrCreateDmConversationApi.mockResolvedValue({
            data: { ok: true, conversation: { id: "c1", type: "dm", context_id: null, created_at: "2026-07-01T00:00:00Z" } },
        });

        await useChatStore.getState().openConversation("them", "Bob");

        expect(useChatStore.getState().conversations).toHaveLength(1);
        expect(listMessagesApi).not.toHaveBeenCalled(); // already cached
    });
});

describe("chatStore.fetchMessages", () => {
    it("replaces the cache on an initial (non-loadOlder) fetch", async () => {
        useChatStore.setState({ messagesByConversation: { c1: [message({ id: "stale" })] } });
        listMessagesApi.mockResolvedValue({ data: { ok: true, data: [message({ id: "fresh" })], nextCursor: "cursor-1" } });

        await useChatStore.getState().fetchMessages("c1");

        const s = useChatStore.getState();
        expect(s.messagesByConversation["c1"]).toEqual([message({ id: "fresh" })]);
        expect(s.messageCursors["c1"]).toBe("cursor-1");
    });

    it("appends (not replaces) on loadOlder, using the stored cursor", async () => {
        useChatStore.setState({
            messagesByConversation: { c1: [message({ id: "newer" })] },
            messageCursors: { c1: "cursor-1" },
        });
        listMessagesApi.mockResolvedValue({ data: { ok: true, data: [message({ id: "older" })], nextCursor: null } });

        await useChatStore.getState().fetchMessages("c1", true);

        expect(listMessagesApi).toHaveBeenCalledWith("c1", { cursor: "cursor-1" });
        const msgs = useChatStore.getState().messagesByConversation["c1"]!;
        expect(msgs.map((m) => m.id)).toEqual(["newer", "older"]);
    });

    it("no-ops loadOlder when there's no cursor (no more pages)", async () => {
        useChatStore.setState({ messageCursors: { c1: null } });
        await useChatStore.getState().fetchMessages("c1", true);
        expect(listMessagesApi).not.toHaveBeenCalled();
    });
});

describe("chatStore.sendMessage", () => {
    it("prepends the sent message and moves the conversation to the front", async () => {
        useChatStore.setState({
            conversations: [conversation({ id: "c1" }), conversation({ id: "c2", other_display_name: "Dave" })],
            messagesByConversation: { c2: [message({ id: "old", conversation_id: "c2" })] },
        });
        sendMessageApi.mockResolvedValue({ data: { ok: true, message: message({ id: "new", conversation_id: "c2", body: "hey" }) } });

        await useChatStore.getState().sendMessage("c2", "hey");

        const s = useChatStore.getState();
        expect(s.messagesByConversation["c2"]![0]!.id).toBe("new");
        expect(s.conversations[0]!.id).toBe("c2"); // touched to front
    });

    it("propagates errors (rate limit / profanity / empty) for the caller to surface", async () => {
        sendMessageApi.mockRejectedValue(new Error("message_contains_profanity"));
        await expect(useChatStore.getState().sendMessage("c1", "bad")).rejects.toThrow("message_contains_profanity");
    });
});

describe("chatStore.unreadTotal", () => {
    it("sums unread counts across all conversations", () => {
        useChatStore.setState({ unreadByConversation: { c1: 2, c2: 5, c3: 0 } });
        expect(useChatStore.getState().unreadTotal()).toBe(7);
    });

    it("is 0 when there's nothing unread", () => {
        expect(useChatStore.getState().unreadTotal()).toBe(0);
    });
});

describe("chatStore.onMessageReceived", () => {
    it("live-appends without incrementing unread when the conversation is active", () => {
        useChatStore.setState({
            conversations: [conversation({ id: "c1" })],
            activeConversationId: "c1",
        });

        useChatStore.getState().onMessageReceived({
            conversationId: "c1",
            conversationType: "dm",
            messageId: "m-new",
            senderId: "them",
            senderName: "Bob",
            body: "yo",
            imageUrl: null,
            createdAt: "2026-07-01T00:01:00Z",
        });

        const s = useChatStore.getState();
        expect(s.messagesByConversation["c1"]![0]!.id).toBe("m-new");
        expect(s.unreadByConversation["c1"] ?? 0).toBe(0);
    });

    it("increments unread and touches the conversation to front when NOT active", () => {
        useChatStore.setState({
            conversations: [conversation({ id: "c1" }), conversation({ id: "c2", other_display_name: "Eve" })],
            activeConversationId: "c1",
        });

        useChatStore.getState().onMessageReceived({
            conversationId: "c2",
            conversationType: "dm",
            messageId: "m-new",
            senderId: "eve-id",
            senderName: "Eve",
            body: "hey",
            imageUrl: null,
            createdAt: "2026-07-01T00:01:00Z",
        });

        const s = useChatStore.getState();
        expect(s.unreadByConversation["c2"]).toBe(1);
        expect(s.conversations[0]!.id).toBe("c2");
    });

    it("synthesizes a new conversation entry for a message from an unknown conversation", () => {
        useChatStore.getState().onMessageReceived({
            conversationId: "brand-new",
            conversationType: "dm",
            messageId: "m1",
            senderId: "stranger-id",
            senderName: "Stranger",
            body: "hi there",
            imageUrl: null,
            createdAt: "2026-07-01T00:01:00Z",
        });

        const s = useChatStore.getState();
        expect(s.conversations[0]!.id).toBe("brand-new");
        expect(s.conversations[0]!.other_display_name).toBe("Stranger");
        expect(s.unreadByConversation["brand-new"]).toBe(1);
    });

    it("increments unread across multiple messages while inactive", () => {
        useChatStore.setState({ conversations: [conversation({ id: "c1" })], activeConversationId: null });
        const push = (id: string) =>
            useChatStore.getState().onMessageReceived({
                conversationId: "c1",
                conversationType: "dm",
                messageId: id,
                senderId: "them",
                senderName: "Bob",
                body: "x",
                imageUrl: null,
                createdAt: "2026-07-01T00:01:00Z",
            });
        push("m1");
        push("m2");
        push("m3");
        expect(useChatStore.getState().unreadByConversation["c1"]).toBe(3);
    });
});
