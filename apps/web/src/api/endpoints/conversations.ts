import client from "../client";
import type { Conversation, Message } from "@/types/api";

export function getOrCreateDmConversation(friendId: string) {
    return client.post<{ ok: true; conversation: Conversation }>("/v1/conversations/dm", { friendId });
}

export function listConversations() {
    return client.get<{ ok: true; conversations: Conversation[] }>("/v1/conversations");
}

export function listMessages(conversationId: string, params: { limit?: number; cursor?: string } = {}) {
    return client.get<{ ok: true; data: Message[]; nextCursor: string | null }>(
        `/v1/conversations/${conversationId}/messages`,
        { params },
    );
}

export function sendMessage(conversationId: string, body: string) {
    return client.post<{ ok: true; message: Message }>(`/v1/conversations/${conversationId}/messages`, { body });
}
