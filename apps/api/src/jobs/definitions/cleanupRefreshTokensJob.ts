import type { JobDefinition } from "../jobTypes";
import { cleanupTokensDeletedTotal } from "../../metrics";

export const cleanupRefreshTokensJob: JobDefinition = {
    name: "cleanup-refresh-tokens",
    intervalSeconds: 3600,
    timeoutMs: 30_000,
    async run(ctx) {
        const result = await ctx.pool.query(
            `DELETE FROM refresh_tokens
             WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '1 hour')
                OR expires_at < now()`
        );
        const deleted = result.rowCount ?? 0;
        cleanupTokensDeletedTotal.inc(deleted);
        ctx.logger.info({ deleted }, "Cleaned up refresh tokens");
    },
};
