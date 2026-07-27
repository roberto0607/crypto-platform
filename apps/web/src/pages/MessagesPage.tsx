import { FriendRequestsList } from "@/components/messages/FriendRequestsList";

// Phase 1 scope: friends + friend requests only. Conversations/messages
// (Phase 2) extend this page with a "Chats" section once there's a second
// thing to show — no placeholder tab built ahead of that.
export default function MessagesPage() {
    return (
        <div className="space-y-6">
            <h1 className="text-xl font-semibold">Messages</h1>
            <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
                <FriendRequestsList />
            </div>
        </div>
    );
}
