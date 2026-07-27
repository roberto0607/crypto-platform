import client from "../client";

// Response carries the flagged_messages row, but callers only need to know
// the report succeeded — nothing from it is rendered.
export function reportMessage(messageId: string, reason?: string) {
    return client.post<{ ok: true; flagged: unknown }>(`/v1/messages/${messageId}/report`, reason ? { reason } : {});
}
