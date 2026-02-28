import type { JobDefinition } from "../jobTypes";
import { replaySessionsCleanedTotal } from "../../metrics";

const STALE_MINUTES = 30;

export const cleanupReplaySessionsJob: JobDefinition = {
    name: "cleanup-replay-sessions",
    intervalSeconds: 600,
    timeoutMs: 15_000,
    async run(ctx) {
        const result = await ctx.pool.query(
            `DELETE FROM replay_sessions
             WHERE is_active = true
               AND updated_at < now() - make_interval(mins => $1)`,
            [STALE_MINUTES]
        );
        const cleaned = result.rowCount ?? 0;
        replaySessionsCleanedTotal.inc(cleaned);
        ctx.logger.info({ cleaned, staleMinutes: STALE_MINUTES }, "Cleaned up stale replay sessions");
    },
};
