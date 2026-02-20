import { pool } from "../db/pool";

export type UserRow = {
    id: string;
    email: string;
    email_normalized: string;
    role: string;
    created_at: string;
    updated_at: string;
};

export async function createUser(params: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
}): Promise<UserRow> {
    const { email, emailNormalized, passwordHash } = params;

    const result = await pool.query<UserRow>(
        `
        INSERT INTO users (email, email_normalized, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, email, email_normalized, role, created_at, updated_at
        `,
        [email, emailNormalized, passwordHash]
    );

    return result.rows[0];
}

export async function findUserByEmailNormalized(emailNormalized: string): Promise<(UserRow & {password_hash: string }) | null> {
    const result = await pool.query(
        `
        SELECT id, email, email_normalized, password_hash, role, created_at, updated_at
        FROM users
        WHERE email_normalized = $1
        LIMIT 1
        `,
        [emailNormalized]
    );

    return result.rows[0] ?? null;
}