import type { Conversation } from "@/types/api";

interface ConversationRowProps {
    conversation: Conversation;
    unreadCount: number;
    isActive: boolean;
    onClick: () => void;
}

export function ConversationRow({ conversation, unreadCount, isActive, onClick }: ConversationRowProps) {
    const name = conversation.other_display_name || "Unknown";

    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-4 py-3 border-b border-gray-800/50 text-left transition-colors ${
                isActive ? "bg-gray-800/60" : "hover:bg-gray-800/30"
            }`}
        >
            <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs text-gray-400 flex-shrink-0">
                {name.slice(0, 2).toUpperCase()}
            </div>
            <span className={`flex-1 min-w-0 truncate text-sm ${unreadCount > 0 ? "text-white font-medium" : "text-gray-300"}`}>
                {name}
            </span>
            {unreadCount > 0 && (
                <span className="flex-shrink-0 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {unreadCount > 9 ? "9+" : unreadCount}
                </span>
            )}
        </button>
    );
}
