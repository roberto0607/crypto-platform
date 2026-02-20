import { pool } from "../db/pool";

export type RefreshTokenRow = {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
};

export async function findValidRefreshTokenByHash(tokenHash: string) {
    const res = await pool.query<RefreshTokenRow>(
        `
        SELECT id, user_id, token_hash, expires_at, revoked_at
        FROM refresh_tokens
        WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > now()
        LIMIT 1
        `,
        [tokenHash]
    );
    return res.rows[0] ?? null;
}

export async function revokeRefreshTokenById(id: string) {
    await pool.query(
        `
        UPDATE refresh_tokens
        SET revoked_at = now()
        WHERE id = $1
        `,
        [id]
    );
}