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
}) {
    const { userId, tokenHash, expiresAt } = args;

    await pool.query(
        `
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
        `,
        [userId, tokenHash, expiresAt]
    );
}