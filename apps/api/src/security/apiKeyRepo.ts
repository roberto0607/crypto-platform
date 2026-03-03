import { pool } from "../db/pool";

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_hash: string;
  label: string;
  scopes: string[];
  last_used_at: string | null;
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
}

/** Insert a new API key. */
export async function createApiKey(params: {
  userId: string;
  keyHash: string;
  label: string;
  scopes: string[];
  expiresAt?: Date | null;
}): Promise<ApiKeyRow> {
  const { userId, keyHash, label, scopes, expiresAt } = params;
  const result = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys (user_id, key_hash, label, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, keyHash, label, scopes, expiresAt ?? null],
  );
  return result.rows[0];
}

/** Find a non-revoked, non-expired key by its hash. */
export async function findByHash(keyHash: string): Promise<ApiKeyRow | null> {
  const result = await pool.query<ApiKeyRow>(
    `SELECT * FROM api_keys
     WHERE key_hash = $1
       AND revoked = false
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [keyHash],
  );
  return result.rows[0] ?? null;
}

/** Mark a key as revoked. */
export async function revokeApiKey(id: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE api_keys SET revoked = true
     WHERE id = $1 AND user_id = $2 AND revoked = false`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** List all keys for a user (excluding key_hash). */
export async function listApiKeysForUser(userId: string): Promise<Omit<ApiKeyRow, "key_hash">[]> {
  const result = await pool.query<Omit<ApiKeyRow, "key_hash">>(
    `SELECT id, user_id, label, scopes, last_used_at, revoked, expires_at, created_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

/** Update last_used_at timestamp. Fire-and-forget. */
export async function touchLastUsed(id: string): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
    [id],
  );
}
