import { useEffect } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useToast } from "@/components/ToastProvider";
import { FriendRequestRow } from "./FriendRequestRow";

function errMessage(err: unknown, fallback: string): string {
    const anyErr = err as { response?: { data?: { message?: string } } };
    return anyErr?.response?.data?.message ?? fallback;
}

interface FriendRequestsListProps {
    /** Called with (friendId, friendDisplayName) when "Message" is clicked on a friend row. */
    onMessageFriend?: (friendId: string, friendDisplayName: string | null) => void;
}

export function FriendRequestsList({ onMessageFriend }: FriendRequestsListProps = {}) {
    const {
        friends,
        incomingRequests,
        outgoingRequests,
        friendsLoaded,
        fetchFriends,
        acceptFriendRequest,
        rejectFriendRequest,
        blockUser,
    } = useChatStore();
    const { addToast } = useToast();

    useEffect(() => {
        fetchFriends();
    }, [fetchFriends]);

    async function handleAccept(id: string) {
        try {
            await acceptFriendRequest(id);
        } catch (err) {
            addToast("error", errMessage(err, "Failed to accept friend request"));
        }
    }

    async function handleReject(id: string) {
        try {
            await rejectFriendRequest(id);
        } catch (err) {
            addToast("error", errMessage(err, "Failed to reject friend request"));
        }
    }

    async function handleBlock(targetId: string) {
        try {
            await blockUser(targetId);
        } catch (err) {
            addToast("error", errMessage(err, "Failed to block user"));
        }
    }

    if (!friendsLoaded) {
        return <div className="text-gray-500 text-sm text-center py-8">Loading...</div>;
    }

    return (
        <div>
            {incomingRequests.length > 0 && (
                <section>
                    <div className="px-4 pt-3 pb-1 text-[10px] tracking-[2px] text-gray-500 uppercase">
                        Requests ({incomingRequests.length})
                    </div>
                    {incomingRequests.map((f) => (
                        <FriendRequestRow
                            key={f.id}
                            friendship={f}
                            variant="incoming"
                            onAccept={() => handleAccept(f.id)}
                            onReject={() => handleReject(f.id)}
                            onBlock={() => f.other_user_id && handleBlock(f.other_user_id)}
                        />
                    ))}
                </section>
            )}

            {outgoingRequests.length > 0 && (
                <section>
                    <div className="px-4 pt-3 pb-1 text-[10px] tracking-[2px] text-gray-500 uppercase">
                        Sent ({outgoingRequests.length})
                    </div>
                    {outgoingRequests.map((f) => (
                        <FriendRequestRow key={f.id} friendship={f} variant="outgoing" />
                    ))}
                </section>
            )}

            <section>
                <div className="px-4 pt-3 pb-1 text-[10px] tracking-[2px] text-gray-500 uppercase">
                    Friends ({friends.length})
                </div>
                {friends.length === 0 ? (
                    <div className="text-gray-500 text-sm text-center py-8">
                        No friends yet
                    </div>
                ) : (
                    friends.map((f) => (
                        <FriendRequestRow
                            key={f.id}
                            friendship={f}
                            variant="friend"
                            onBlock={() => f.other_user_id && handleBlock(f.other_user_id)}
                            onMessage={() => f.other_user_id && onMessageFriend?.(f.other_user_id, f.other_display_name ?? null)}
                        />
                    ))
                )}
            </section>
        </div>
    );
}
