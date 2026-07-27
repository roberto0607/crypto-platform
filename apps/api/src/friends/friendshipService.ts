import { pool } from "../db/pool.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { AppError } from "../errors/AppError.js";
import {
    findFriendshipBetween,
    getFriendshipById,
    createFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    blockUser,
    listFriendshipsForUser,
    type FriendshipRow,
    type FriendListRow,
} from "./friendshipRepo.js";

async function getDisplayName(userId: string): Promise<string> {
    const { rows } = await pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`,
        [userId],
    );
    return rows[0]?.display_name ?? "Unknown";
}

export async function sendFriendRequest(
    userId: string,
    friendId: string,
): Promise<FriendshipRow> {
    if (userId === friendId) {
        throw new AppError("cannot_friend_self");
    }

    const { rows: targetRows } = await pool.query(`SELECT id FROM users WHERE id = $1`, [friendId]);
    if (targetRows.length === 0) {
        throw new AppError("user_not_found");
    }

    const existing = await findFriendshipBetween(userId, friendId);
    if (existing) {
        throw new AppError("friendship_already_exists");
    }

    const friendship = await createFriendRequest(userId, friendId);
    const requesterName = await getDisplayName(userId);

    publish(createEvent("friend_request.received", {
        friendshipId: friendship.id,
        requesterId: userId,
        requesterName,
        createdAt: friendship.created_at,
    }, { userId: friendId }));

    return friendship;
}

/**
 * Distinguishes the three ways an accept/reject can fail so the caller
 * (not the recipient) gets `forbidden`, not a misleading `friendship_not_pending`
 * that would otherwise leak that the friendship row exists at all.
 */
function actionableFailure(existing: FriendshipRow | null, userId: string): AppError {
    if (!existing) return new AppError("friendship_not_found");
    if (existing.friend_id !== userId) return new AppError("forbidden");
    return new AppError("friendship_not_pending");
}

export async function acceptFriendRequestAsUser(
    id: string,
    userId: string,
): Promise<FriendshipRow> {
    const friendship = await acceptFriendRequest(id, userId);
    if (!friendship) {
        throw actionableFailure(await getFriendshipById(id), userId);
    }

    const accepterName = await getDisplayName(userId);

    publish(createEvent("friend_request.accepted", {
        friendshipId: friendship.id,
        accepterId: userId,
        accepterName,
    }, { userId: friendship.user_id }));

    return friendship;
}

export async function rejectFriendRequestAsUser(id: string, userId: string): Promise<void> {
    const ok = await rejectFriendRequest(id, userId);
    if (!ok) {
        throw actionableFailure(await getFriendshipById(id), userId);
    }
}

export async function blockUserAsUser(
    blockerId: string,
    targetId: string,
): Promise<FriendshipRow> {
    if (blockerId === targetId) {
        throw new AppError("cannot_friend_self");
    }
    return blockUser(blockerId, targetId);
}

export interface FriendsListResult {
    friends: FriendListRow[];
    incomingRequests: FriendListRow[];
    outgoingRequests: FriendListRow[];
}

export async function listFriends(userId: string): Promise<FriendsListResult> {
    const rows = await listFriendshipsForUser(userId);
    return {
        friends: rows.filter((r) => r.status === "accepted"),
        incomingRequests: rows.filter((r) => r.status === "pending" && r.friend_id === userId),
        outgoingRequests: rows.filter((r) => r.status === "pending" && r.user_id === userId),
    };
}
