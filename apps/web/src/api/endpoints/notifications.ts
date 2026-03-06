import client from "../client";

export interface Notification {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    metadata: Record<string, unknown>;
    read_at: string | null;
    created_at: string;
}

export function listNotifications(limit?: number) {
    return client.get<{ ok: true; notifications: Notification[]; unreadCount: number }>(
        "/v1/notifications",
        { params: { limit } },
    );
}

export function markNotificationRead(id: string) {
    return client.post<{ ok: true }>(`/v1/notifications/${id}/read`);
}

export function markAllNotificationsRead() {
    return client.post<{ ok: true; markedRead: number }>("/v1/notifications/read-all");
}
