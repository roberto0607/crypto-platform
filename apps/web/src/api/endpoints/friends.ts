import client from "../client";
import type { Friendship } from "@/types/api";

export function sendFriendRequest(friendId: string) {
    return client.post<{ ok: true; friendship: Friendship }>("/v1/friends/request", { friendId });
}

export function acceptFriendRequest(friendshipId: string) {
    return client.post<{ ok: true; friendship: Friendship }>(`/v1/friends/${friendshipId}/accept`);
}

export function rejectFriendRequest(friendshipId: string) {
    return client.post<{ ok: true }>(`/v1/friends/${friendshipId}/reject`);
}

export function blockUser(targetId: string) {
    return client.post<{ ok: true; friendship: Friendship }>("/v1/friends/block", { targetId });
}

export function listFriends() {
    return client.get<{
        ok: true;
        friends: Friendship[];
        incomingRequests: Friendship[];
        outgoingRequests: Friendship[];
    }>("/v1/friends");
}
