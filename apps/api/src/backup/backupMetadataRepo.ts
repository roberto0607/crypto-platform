/**
 * backupMetadataRepo.ts — Repository for the backup_metadata table.
 */

import { pool } from "../db/pool";

export interface BackupMetadataRow {
  id: string;
  filename: string;
  size_bytes: string;
  created_at: string;
  verified_restore: boolean;
  verified_at: string | null;
}

export async function listBackups(limit = 50): Promise<BackupMetadataRow[]> {
  const res = await pool.query<BackupMetadataRow>(
    `SELECT id, filename, size_bytes, created_at, verified_restore, verified_at
     FROM backup_metadata
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function markVerified(filename: string): Promise<void> {
  await pool.query(
    `UPDATE backup_metadata
     SET verified_restore = true, verified_at = now()
     WHERE filename = $1`,
    [filename]
  );
}
