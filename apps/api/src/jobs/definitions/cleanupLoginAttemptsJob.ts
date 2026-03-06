import type { JobDefinition } from "../jobTypes";
import { loginAttemptsDeletedTotal } from "../../metrics";

export const cleanupLoginAttemptsJob: JobDefinition = {
    name: "cleanup-login-attempts",
    intervalSeconds: 3600,
    timeoutMs: 30_000,
    async run(ctx) {
        const result = await ctx.pool.query(
            `DELETE FROM login_attempts WHERE created_at < now() - interval '24 hours'`
        );
        const deleted = result.rowCount ?? 0;
        loginAttemptsDeletedTotal.inc(deleted);
        ctx.logger.info({ deleted }, "Cleaned up login attempts");
    },
};
