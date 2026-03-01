import type { PoolClient } from "pg";
import { auditLog } from "../audit/log";

/**
 * Mark users as QUARANTINED in account_limits (upsert).
 * Write audit_log entries for each user.
 */
export async function quarantineUsersTx(
  client: PoolClient,
  userIds: string[],
  reason: string,
  runId: string,
): Promise<void> {
  if (userIds.length === 0) return;

  for (const userId of userIds) {
    await client.query(
      `INSERT INTO account_limits (user_id, account_status)
       VALUES ($1, 'QUARANTINED')
       ON CONFLICT (user_id)
       DO UPDATE SET account_status = 'QUARANTINED',
                     updated_at = now()`,
      [userId],
    );

    await auditLog({
      actorUserId: null,
      action: "USER_QUARANTINED",
      targetType: "user",
      targetId: userId,
      metadata: { runId, reason },
    });
  }
}

/**
 * Unquarantine a user: set account_status back to ACTIVE.
 * Write audit_log entry.
 */
export async function unquarantineUserTx(
  client: PoolClient,
  userId: string,
  actorUserId: string,
): Promise<void> {
  await client.query(
    `UPDATE account_limits
     SET account_status = 'ACTIVE', updated_at = now()
     WHERE user_id = $1 AND account_status = 'QUARANTINED'`,
    [userId],
  );

  await auditLog({
    actorUserId,
    action: "USER_UNQUARANTINED",
    targetType: "user",
    targetId: userId,
  });
}
