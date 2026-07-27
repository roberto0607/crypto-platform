import { pool } from "../db/pool.js";

export interface FriendshipRow {
    id: string;
    user_id: string;
    friend_id: string;
    status: "pending" | "accepted" | "blocked";
    created_at: string;
    updated_at: string;
}

export interface FriendListRow extends FriendshipRow {
    other_user_id: string;
    other_display_name: string | null;
}

const COLUMNS = `id, user_id, friend_id, status, created_at, updated_at`;

/** Any row (any status) between the two users, regardless of direction. */
export async function findFriendshipBetween(
    userA: string,
    userB: string,
): Promise<FriendshipRow | null> {
    const { rows } = await pool.query<FriendshipRow>(
        `SELECT ${COLUMNS} FROM friendships
         WHERE (user_id = $1 AND friend_id = $2)
            OR (user_id = $2 AND friend_id = $1)`,
        [userA, userB],
    );
    return rows[0] ?? null;
}

export async function getFriendshipById(id: string): Promise<FriendshipRow | null> {
    const { rows } = await pool.query<FriendshipRow>(
        `SELECT ${COLUMNS} FROM friendships WHERE id = $1`,
        [id],
    );
    return rows[0] ?? null;
}

export async function createFriendRequest(
    userId: string,
    friendId: string,
): Promise<FriendshipRow> {
    const { rows } = await pool.query<FriendshipRow>(
        `INSERT INTO friendships (user_id, friend_id, status)
         VALUES ($1, $2, 'pending')
         RETURNING ${COLUMNS}`,
        [userId, friendId],
    );
    return rows[0];
}

/** Only the recipient (friend_id) can accept, and only while pending. */
export async function acceptFriendRequest(
    id: string,
    recipientId: string,
): Promise<FriendshipRow | null> {
    const { rows } = await pool.query<FriendshipRow>(
        `UPDATE friendships
         SET status = 'accepted'
         WHERE id = $1 AND friend_id = $2 AND status = 'pending'
         RETURNING ${COLUMNS}`,
        [id, recipientId],
    );
    return rows[0] ?? null;
}

/** Only the recipient can reject; deletes the row so a fresh request can follow. */
export async function rejectFriendRequest(
    id: string,
    recipientId: string,
): Promise<boolean> {
    const result = await pool.query(
        `DELETE FROM friendships
         WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
        [id, recipientId],
    );
    return (result.rowCount ?? 0) > 0;
}

/**
 * Block a user. If a friendship row already exists between the two
 * (pending or accepted), it flips to 'blocked'. Otherwise a new row is
 * created directly in 'blocked' state — blocking doesn't require a prior
 * relationship.
 */
export async function blockUser(
    blockerId: string,
    targetId: string,
): Promise<FriendshipRow> {
    const existing = await findFriendshipBetween(blockerId, targetId);
    if (existing) {
        const { rows } = await pool.query<FriendshipRow>(
            `UPDATE friendships SET status = 'blocked' WHERE id = $1 RETURNING ${COLUMNS}`,
            [existing.id],
        );
        return rows[0];
    }
    const { rows } = await pool.query<FriendshipRow>(
        `INSERT INTO friendships (user_id, friend_id, status)
         VALUES ($1, $2, 'blocked')
         RETURNING ${COLUMNS}`,
        [blockerId, targetId],
    );
    return rows[0];
}

/** True if a 'blocked' row exists between the two users, in either direction. */
export async function isBlockedBetween(userA: string, userB: string): Promise<boolean> {
    const row = await findFriendshipBetween(userA, userB);
    return row?.status === "blocked";
}

/**
 * All friendship rows touching `userId`, joined to the other party's
 * display_name. Callers split into accepted / incoming-pending /
 * outgoing-pending by inspecting status + which side userId is on.
 */
export async function listFriendshipsForUser(userId: string): Promise<FriendListRow[]> {
    const { rows } = await pool.query<FriendListRow>(
        `SELECT f.id, f.user_id, f.friend_id, f.status, f.created_at, f.updated_at,
                CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END AS other_user_id,
                u.display_name AS other_display_name
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
         WHERE f.user_id = $1 OR f.friend_id = $1
         ORDER BY f.created_at DESC`,
        [userId],
    );
    return rows;
}
