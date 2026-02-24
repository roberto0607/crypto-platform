/**
 * cleanupRefreshTokens.ts — Remove stale refresh tokens.
 *
 * Deletes rows from refresh_tokens that are either:
 *   - revoked  (revoked_at IS NOT NULL)
 *   - expired  (expires_at < now())
 *
 * Safe to run at any frequency (idempotent).
 *
 * Usage:
 *   pnpm tsx src/scripts/cleanupRefreshTokens.ts
 *   # or via cron: 0 * * * * cd /path/to/apps/api && pnpm tsx src/scripts/cleanupRefreshTokens.ts
 */

import "dotenv/config";
import { pool } from "../db/pool";

async function main() {
  const result = await pool.query(
    `DELETE FROM refresh_tokens
     WHERE revoked_at IS NOT NULL
        OR expires_at < now()`
  );

  console.log(`Cleaned up ${result.rowCount} stale refresh token(s).`);

  await pool.end();
}

main().catch((err) => {
  console.error("Refresh token cleanup failed:", err);
  process.exit(1);
});
