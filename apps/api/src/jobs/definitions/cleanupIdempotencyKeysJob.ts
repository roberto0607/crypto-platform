import type { JobDefinition } from "../jobTypes";
import { idempotencyKeysDeletedTotal } from "../../metrics";

const RETENTION_DAYS = 7;

export const cleanupIdempotencyKeysJob: JobDefinition = {
    name: "cleanup-idempotency-keys",
    intervalSeconds: 86400,
    timeoutMs: 30_000,
    async run(ctx) {
        const result = await ctx.pool.query(
            `DELETE FROM idempotency_keys
             WHERE created_at < now() - make_interval(days => $1)`,
            [RETENTION_DAYS]
        );
        const deleted = result.rowCount ?? 0;
        idempotencyKeysDeletedTotal.inc(deleted);
        ctx.logger.info({ deleted, retentionDays: RETENTION_DAYS }, "Cleaned up idempotency keys");
    },
};
