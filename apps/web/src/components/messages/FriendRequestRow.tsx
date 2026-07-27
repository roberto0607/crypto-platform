import type { Friendship } from "@/types/api";

interface FriendRequestRowProps {
    friendship: Friendship;
    variant: "friend" | "incoming" | "outgoing";
    onAccept?: () => void;
    onReject?: () => void;
    onBlock?: () => void;
    onMessage?: () => void;
}

export function FriendRequestRow({ friendship, variant, onAccept, onReject, onBlock, onMessage }: FriendRequestRowProps) {
    const name = friendship.other_display_name || "Unknown";

    return (
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800/50">
            <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs text-gray-400 flex-shrink-0">
                    {name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                    <p className="text-sm text-white truncate">{name}</p>
                    {variant === "outgoing" && (
                        <p className="text-xs text-gray-500">Request pending</p>
                    )}
                </div>
            </div>

            {variant === "incoming" && (
                <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                        type="button"
                        onClick={onAccept}
                        className="text-xs px-2.5 py-1 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-colors"
                    >
                        Accept
                    </button>
                    <button
                        type="button"
                        onClick={onReject}
                        className="text-xs px-2.5 py-1 rounded bg-gray-700/50 text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                        Reject
                    </button>
                    <button
                        type="button"
                        onClick={onBlock}
                        className="text-xs px-2.5 py-1 rounded bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors"
                    >
                        Block
                    </button>
                </div>
            )}

            {variant === "friend" && (
                <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                        type="button"
                        onClick={onMessage}
                        className="text-xs px-2.5 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
                    >
                        Message
                    </button>
                    <button
                        type="button"
                        onClick={onBlock}
                        className="text-xs px-2.5 py-1 rounded bg-gray-800/50 text-gray-500 hover:bg-red-600/20 hover:text-red-400 transition-colors"
                    >
                        Block
                    </button>
                </div>
            )}
        </div>
    );
}
