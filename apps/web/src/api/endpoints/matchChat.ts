import client from "../client";
import type { Message } from "@/types/api";

// Match Chat reuses Phase 2's Message shape entirely — the only difference
// from conversations.ts is the matchId->conversation resolution happening
// server-side (see apps/api/src/routes/v1/v1MatchChat.ts).
export function listMatchChatMessages(matchId: string, params: { limit?: number; cursor?: string } = {}) {
    return client.get<{ ok: true; data: Message[]; nextCursor: string | null }>(
        `/v1/matches/${matchId}/chat/messages`,
        { params },
    );
}

export function sendMatchChatMessage(matchId: string, body: string) {
    return client.post<{ ok: true; message: Message }>(`/v1/matches/${matchId}/chat/messages`, { body });
}
