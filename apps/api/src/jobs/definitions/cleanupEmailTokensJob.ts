import type { JobDefinition } from "../jobTypes";

export const cleanupEmailTokensJob: JobDefinition = {
    name: "cleanup-email-tokens",
    intervalSeconds: 3600,
    timeoutMs: 30_000,
    async run(ctx) {
        const result = await ctx.pool.query(
            `DELETE FROM email_tokens
             WHERE (used_at IS NOT NULL AND used_at < now() - interval '7 days')
                OR (expires_at < now() - interval '7 days')`
        );
        const deleted = result.rowCount ?? 0;
        ctx.logger.info({ deleted }, "Cleaned up email tokens");
    },
};
