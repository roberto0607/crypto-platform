import type { PoolClient } from "pg";
import { pool } from "../db/pool";

export interface InviteRow {
  id: string;
  code: string;
  created_by: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  disabled: boolean;
  created_at: string;
}

export async function createInvite(
  code: string,
  createdBy: string,
  maxUses: number = 1,
  expiresAt: string | null = null,
): Promise<InviteRow> {
  const result = await pool.query<InviteRow>(
    `INSERT INTO beta_invites (code, created_by, max_uses, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [code, createdBy, maxUses, expiresAt],
  );
  return result.rows[0];
}

export async function validateInvite(code: string): Promise<InviteRow | null> {
  const result = await pool.query<InviteRow>(
    `SELECT * FROM beta_invites
     WHERE code = $1
       AND disabled = false
       AND used_count < max_uses
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [code],
  );
  return result.rows[0] ?? null;
}

export async function consumeInviteTx(
  client: PoolClient,
  inviteId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE beta_invites
     SET used_count = used_count + 1
     WHERE id = $1
       AND used_count < max_uses
       AND disabled = false`,
    [inviteId],
  );
  if (result.rowCount === 0) {
    throw new Error("invite_invalid");
  }
}

export async function listInvites(): Promise<InviteRow[]> {
  const result = await pool.query<InviteRow>(
    `SELECT * FROM beta_invites ORDER BY created_at DESC`,
  );
  return result.rows;
}

export async function disableInvite(inviteId: string): Promise<InviteRow | null> {
  const result = await pool.query<InviteRow>(
    `UPDATE beta_invites SET disabled = true WHERE id = $1 RETURNING *`,
    [inviteId],
  );
  return result.rows[0] ?? null;
}
