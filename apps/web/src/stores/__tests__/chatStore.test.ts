import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Friendship } from "@/types/api";

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

beforeEach(() => {
    sendFriendRequestApi.mockReset();
    acceptFriendRequestApi.mockReset();
    rejectFriendRequestApi.mockReset();
    blockUserApi.mockReset();
    listFriendsApi.mockReset();
    useChatStore.setState({
        friends: [],
        incomingRequests: [],
        outgoingRequests: [],
        friendsLoaded: false,
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
