import type { JobDefinition } from "../jobTypes";

/**
 * Ghost match cleanup — runs every 5 minutes.
 *
 * Cancels matches stuck in non-terminal states:
 *   - PENDING for > 2 hours (opponent never accepted)
 *   - ACTIVE with ends_at in the past (timer expired, never completed)
 *   - OVERTIME for > 30 minutes with no resolution
 */
export const matchCleanupJob: JobDefinition = {
    name: "match-cleanup",
    intervalSeconds: 300,
    timeoutMs: 30_000,
    async run(ctx) {
        // 1. Stale PENDING matches (> 2 hours old)
        const pending = await ctx.pool.query(
            `UPDATE matches
             SET status = 'CANCELLED', completed_at = now()
             WHERE status = 'PENDING'
               AND created_at < now() - interval '2 hours'
             RETURNING id`,
        );
        const pendingCancelled = pending.rowCount ?? 0;

        // 2. Expired ACTIVE matches (timer ran out)
        const expired = await ctx.pool.query(
            `UPDATE matches
             SET status = 'CANCELLED', completed_at = now()
             WHERE status = 'ACTIVE'
               AND ends_at IS NOT NULL
               AND ends_at < now() - interval '5 minutes'
             RETURNING id`,
        );
        const expiredCancelled = expired.rowCount ?? 0;

        // 3. Stale OVERTIME matches (> 30 minutes)
        const overtime = await ctx.pool.query(
            `UPDATE matches
             SET status = 'CANCELLED', completed_at = now()
             WHERE status = 'OVERTIME'
               AND ends_at IS NOT NULL
               AND ends_at < now() - interval '30 minutes'
             RETURNING id`,
        );
        const overtimeCancelled = overtime.rowCount ?? 0;

        const total = pendingCancelled + expiredCancelled + overtimeCancelled;
        if (total > 0) {
            ctx.logger.info(
                { pendingCancelled, expiredCancelled, overtimeCancelled },
                "ghost_matches_cleaned",
            );
        }
    },
};
