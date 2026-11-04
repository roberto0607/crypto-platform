import type { PoolClient } from "pg";
import { pool } from "../db/pool";

export type UserRow = {
    id: string;
    email: string;
    email_normalized: string;
    role: string;
    display_name: string;
    created_at: string;
    updated_at: string;
};

/** Without a username the column default applies: a generated trader_ name. */
export async function createUser(params: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
    username?: string;
}, db: PoolClient | typeof pool = pool): Promise<UserRow> {
    const { email, emailNormalized, passwordHash, username } = params;

    const returning = "RETURNING id, email, email_normalized, role, display_name, created_at, updated_at";
    const result = username === undefined
        ? await db.query<UserRow>(
            `INSERT INTO users (email, email_normalized, password_hash)
             VALUES ($1, $2, $3) ${returning}`,
            [email, emailNormalized, passwordHash],
        )
        : await db.query<UserRow>(
            `INSERT INTO users (email, email_normalized, password_hash, display_name, username_chosen_at)
             VALUES ($1, $2, $3, $4, now()) ${returning}`,
            [email, emailNormalized, passwordHash, username],
        );

    return result.rows[0];
}

export async function findUserByEmailNormalized(emailNormalized: string): Promise<(UserRow & { password_hash: string; email_verified_at: string | null; username_chosen_at: string | null }) | null> {
    const result = await pool.query(
        `
        SELECT id, email, email_normalized, password_hash, role, display_name, username_chosen_at,
               created_at, updated_at, email_verified_at
        FROM users
        WHERE email_normalized = $1
        LIMIT 1
        `,
        [emailNormalized]
    );

    return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>(
        `
        SELECT id, email, email_normalized, role, display_name, created_at, updated_at
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );

    return result.rows[0] ?? null;
}

export async function updateUserRole(id: string, role: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>(
        `
        UPDATE users SET role = $1, updated_at = now()
        WHERE id = $2
        RETURNING id, email, email_normalized, role, created_at, updated_at
        `,
        [role, id]
    );

    return result.rows[0] ?? null;
}

export async function listUsers(): Promise<UserRow[]> {
    const result = await pool.query<UserRow>(
        `
        SELECT id, email, email_normalized, role, created_at, updated_at
        FROM users
        ORDER BY created_at
        `
    );

    return result.rows;
}
export type PublicPlayer = {
    id: string;
    username: string;
    tier: string;
    elo: number;
    wins: number;
    losses: number;
};

/**
 * Served by users_display_name_lower_uq, for the filter and the order: the
 * ~<~ operator is the order text_pattern_ops stores, so LIMIT stops at 10 rows.
 * $1 is a LIKE pattern, $2 the ids to leave out. Selects public columns only.
 * The domains are system accounts and the ones seed and smoke scripts use, so
 * only real players are found. That hides the seeded demo@demo.local too.
 */
export const PLAYER_SEARCH_SQL = `
    SELECT u.id,
           u.display_name AS username,
           COALESCE(ut.tier, 'ROOKIE') AS tier,
           u.elo_rating AS elo,
           u.win_count AS wins,
           u.loss_count AS losses
      FROM users u
      LEFT JOIN user_tiers ut ON ut.user_id = u.id
     WHERE lower(u.display_name) LIKE $1
       AND u.id <> ALL($2::uuid[])
       AND split_part(u.email_normalized, '@', 2) NOT IN (
           'system.local', 'test.local', 'loadtest.local', 'demo.local', 'test.com', 'example.com'
       )
     ORDER BY lower(u.display_name) USING ~<~
     LIMIT 10`;

/** `prefix` must already be a valid username fragment: only _ needs escaping. */
export function playerSearchPattern(prefix: string): string {
    return `${prefix.toLowerCase().replace(/_/g, "\\_")}%`;
}

export async function searchPlayers(prefix: string, excludeIds: string[]): Promise<PublicPlayer[]> {
    const { rows } = await pool.query<PublicPlayer>(PLAYER_SEARCH_SQL, [playerSearchPattern(prefix), excludeIds]);
    return rows;
}
