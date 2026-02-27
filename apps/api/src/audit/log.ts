import { pool } from "../db/pool";
import { logger } from "../observability/logContext";

export async function auditLog(entry: {
    actorUserId: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: any;
}) {
    const {
        actorUserId,
        action,
        targetType = null,
        targetId = null,
        requestId = null,
        ip = null,
        userAgent = null,
        metadata = {},
    } = entry;

    try {
        await pool.query(
            `
            INSERT INTO audit_log (
            actor_user_id, action, target_type, target_id, request_id, ip, user_agent, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            `,
            [actorUserId, action, targetType, targetId, requestId, ip, userAgent, JSON.stringify(metadata)]
        );
    } catch (err) {
        logger.error({ eventType: "audit.write_failed", action, requestId, err }, "auditLog failed");
    }
}
