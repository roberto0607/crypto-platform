import { pool } from "../db/pool";
import { createHash, randomBytes } from "node:crypto";

export function newRefreshToken(): { token: string; tokenHash: string } {
    const token = randomBytes(64).toString("hex"); //128 hex chars
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return { token, tokenHash };
}

export async function storeRefreshToken(args: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    familyId?: string;
}): Promise<{ id: string; familyId: string }> {
    const { userId, tokenHash, expiresAt, familyId } = args;

    if (familyId) {
        const result = await pool.query<{ id: string; family_id: string }>(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, family_id`,
            [userId, tokenHash, expiresAt, familyId]
        );
        if (!result.rows || result.rows.length === 0) {
            throw new Error("Token insert failed — no row returned");
        }
        return { id: result.rows[0].id, familyId: result.rows[0].family_id };
    }

    const result = await pool.query<{ id: string; family_id: string }>(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id, family_id`,
        [userId, tokenHash, expiresAt]
    );
    if (!result.rows || result.rows.length === 0) {
        throw new Error("Token insert failed — no row returned");
    }
    return { id: result.rows[0].id, familyId: result.rows[0].family_id };
}