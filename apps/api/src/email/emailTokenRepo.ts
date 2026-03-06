import crypto from "node:crypto";
import { pool } from "../db/pool.js";

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");  // 64 hex chars
  return { raw, hash: hashToken(raw) };
}

export async function createEmailToken(
  userId: string,
  kind: "EMAIL_VERIFY" | "PASSWORD_RESET",
  ttlMinutes: number
): Promise<string> {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  // Invalidate any existing unused tokens of the same kind for this user
  await pool.query(
    `UPDATE email_tokens SET used_at = now()
     WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`,
    [userId, kind]
  );

  await pool.query(
    `INSERT INTO email_tokens (user_id, token_hash, kind, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash, kind, expiresAt]
  );

  return raw;  // Return raw token for email URL
}

export async function consumeEmailToken(
  rawToken: string,
  kind: "EMAIL_VERIFY" | "PASSWORD_RESET"
): Promise<{ userId: string } | null> {
  const hash = hashToken(rawToken);

  const { rows } = await pool.query(
    `UPDATE email_tokens
     SET used_at = now()
     WHERE token_hash = $1
       AND kind = $2
       AND used_at IS NULL
       AND expires_at > now()
     RETURNING user_id`,
    [hash, kind]
  );

  return rows.length > 0 ? { userId: rows[0].user_id } : null;
}
