import { create } from "zustand";
import {
    listNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    type Notification,
} from "@/api/endpoints/notifications";

interface NotificationState {
    notifications: Notification[];
    unreadCount: number;
    panelOpen: boolean;

    fetch: () => Promise<void>;
    markRead: (id: string) => Promise<void>;
    markAllRead: () => Promise<void>;
    togglePanel: () => void;
    closePanel: () => void;
    incrementUnread: () => void;
    addNotification: (n: Partial<Notification>) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
    notifications: [],
    unreadCount: 0,
    panelOpen: false,

    async fetch() {
        try {
            const { data } = await listNotifications(50);
            set({
                notifications: data.notifications,
                unreadCount: data.unreadCount,
            });
        } catch {
            // Non-fatal
        }
    },

    async markRead(id) {
        // Optimistic update
        set((s) => ({
            notifications: s.notifications.map((n) =>
                n.id === id ? { ...n, read_at: new Date().toISOString() } : n,
            ),
            unreadCount: Math.max(0, s.unreadCount - 1),
        }));
        await markNotificationRead(id).catch(() => {});
    },

    async markAllRead() {
        set((s) => ({
            notifications: s.notifications.map((n) => ({
                ...n,
                read_at: n.read_at ?? new Date().toISOString(),
            })),
            unreadCount: 0,
        }));
        await markAllNotificationsRead().catch(() => {});
    },

    togglePanel() {
        set((s) => ({ panelOpen: !s.panelOpen }));
    },

    closePanel() {
        set({ panelOpen: false });
    },

    incrementUnread() {
        set((s) => ({ unreadCount: s.unreadCount + 1 }));
    },

    addNotification(n) {
        set((s) => ({
            notifications: [
                {
                    id: n.id ?? crypto.randomUUID(),
                    kind: n.kind ?? "SYSTEM",
                    title: n.title ?? "",
                    body: n.body ?? null,
                    metadata: n.metadata ?? {},
                    read_at: null,
                    created_at: n.created_at ?? new Date().toISOString(),
                },
                ...s.notifications,
            ].slice(0, 100),
            unreadCount: s.unreadCount + 1,
        }));
    },
}));
