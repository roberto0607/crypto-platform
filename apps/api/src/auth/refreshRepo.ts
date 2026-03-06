import { pool } from "../db/pool";

export type RefreshTokenRow = {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
    family_id: string;
    replaced_by_id: string | null;
};

/**
 * Find a refresh token by hash. Returns the row even if revoked
 * (so the caller can detect reuse). Returns null only if the token
 * doesn't exist or is expired.
 */
export async function findRefreshTokenByHash(tokenHash: string) {
    const res = await pool.query<RefreshTokenRow>(
        `SELECT id, user_id, token_hash, expires_at, revoked_at,
                family_id, replaced_by_id
         FROM refresh_tokens
         WHERE token_hash = $1
           AND expires_at > now()
         LIMIT 1`,
        [tokenHash]
    );
    return res.rows[0] ?? null;
}

export async function revokeRefreshTokenById(id: string) {
    await pool.query(
        `UPDATE refresh_tokens
         SET revoked_at = now()
         WHERE id = $1`,
        [id]
    );
}

/** Revoke ALL tokens in a family (nuclear option on reuse detection). */
export async function revokeTokenFamily(familyId: string): Promise<number> {
    const result = await pool.query(
        `UPDATE refresh_tokens
         SET revoked_at = now()
         WHERE family_id = $1
           AND revoked_at IS NULL`,
        [familyId]
    );
    return result.rowCount ?? 0;
}

/** Mark a token as replaced by another (chain tracking). */
export async function markReplacedBy(tokenId: string, replacedById: string): Promise<void> {
    await pool.query(
        `UPDATE refresh_tokens
         SET replaced_by_id = $1
         WHERE id = $2`,
        [replacedById, tokenId]
    );
}