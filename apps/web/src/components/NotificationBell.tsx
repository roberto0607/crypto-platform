import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/stores/notificationStore";

const KIND_ICONS: Record<string, string> = {
    COMPETITION_STARTED: "!",
    COMPETITION_ENDED: "*",
    RANK_CHANGED: "#",
    TRIGGER_FIRED: "T",
    ORDER_FILLED: "$",
    SYSTEM: "i",
};

export function NotificationBell() {
    const { unreadCount, notifications, panelOpen, togglePanel, closePanel, markRead, markAllRead, fetch } =
        useNotificationStore();
    const panelRef = useRef<HTMLDivElement>(null);

    // Fetch on mount
    useEffect(() => {
        fetch();
    }, [fetch]);

    // Close panel on outside click
    useEffect(() => {
        if (!panelOpen) return;
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                closePanel();
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [panelOpen, closePanel]);

    const recentNotifications = notifications.slice(0, 20);

    return (
        <div className="relative" ref={panelRef}>
            {/* Bell button */}
            <button
                onClick={togglePanel}
                className="relative p-1.5 text-gray-400 hover:text-white transition-colors"
                aria-label="Notifications"
            >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}
            </button>

            {/* Dropdown panel */}
            {panelOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 max-h-[400px] overflow-hidden flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                        <span className="text-sm font-semibold text-white">Notifications</span>
                        {unreadCount > 0 && (
                            <button
                                onClick={markAllRead}
                                className="text-xs text-blue-400 hover:underline"
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    {/* List */}
                    <div className="overflow-y-auto flex-1">
                        {recentNotifications.length === 0 ? (
                            <div className="text-gray-500 text-sm text-center py-8">
                                No notifications
                            </div>
                        ) : (
                            recentNotifications.map((n) => (
                                <button
                                    key={n.id}
                                    onClick={() => {
                                        if (!n.read_at) markRead(n.id);
                                    }}
                                    className={`w-full text-left px-4 py-3 border-b border-gray-800/50 hover:bg-gray-800/50 transition-colors ${
                                        !n.read_at ? "bg-gray-800/30" : ""
                                    }`}
                                >
                                    <div className="flex items-start gap-3">
                                        <span className="text-xs text-gray-500 mt-0.5 w-4 text-center">
                                            {KIND_ICONS[n.kind] ?? "i"}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <p className={`text-sm ${!n.read_at ? "text-white font-medium" : "text-gray-400"}`}>
                                                {n.title}
                                            </p>
                                            {n.body && (
                                                <p className="text-xs text-gray-500 mt-0.5 truncate">
                                                    {n.body}
                                                </p>
                                            )}
                                            <p className="text-[10px] text-gray-600 mt-1">
                                                {new Date(n.created_at).toLocaleString()}
                                            </p>
                                        </div>
                                        {!n.read_at && (
                                            <span className="w-2 h-2 bg-blue-500 rounded-full mt-1.5 flex-shrink-0" />
                                        )}
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
