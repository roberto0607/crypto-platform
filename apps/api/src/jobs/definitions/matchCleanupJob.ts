import type { JobDefinition } from "../jobTypes";
import { completeMatch, mutualForfeitMatch } from "../../competitions/matchService.js";

/**
 * Match cleanup — runs every 5 minutes. Resolves matches stuck in
 * non-terminal states past their deadline:
 *
 *   - PENDING > 2 hours old → CANCELLED (opponent never accepted; no
 *     stakes, no ELO).
 *   - ACTIVE with ends_at in the past → resolved per trade activity:
 *       • has FILLED orders → completeMatch (close positions, apply
 *         ELO, → COMPLETED)
 *       • zero FILLED orders → mutualForfeitMatch (both players take an
 *         ELO loss, → FORFEITED with winner_id = NULL)
 *
 * Expired ACTIVE matches are resolved one at a time in a per-match
 * try/catch loop (capped at 50 per tick) so one failing match cannot
 * break the whole sweep.
 */
export const matchCleanupJob: JobDefinition = {
    name: "match-cleanup",
    intervalSeconds: 300,
    timeoutMs: 30_000,
    async run(ctx) {
        // 1. Stale PENDING matches (> 2 hours old) → CANCELLED.
        //    No per-match work — a bulk UPDATE is fine.
        const pending = await ctx.pool.query(
            `UPDATE matches
             SET status = 'CANCELLED', completed_at = now()
             WHERE status = 'PENDING'
               AND created_at < now() - interval '2 hours'
             RETURNING id`,
        );
        const pendingCancelled = pending.rowCount ?? 0;

        // 2. Expired ACTIVE matches (timer ran out). Resolved per-match:
        //    completeMatch if there were trades, mutualForfeitMatch if not.
        //    Capped at 50 per tick; the rest are picked up next run.
        const { rows: expired } = await ctx.pool.query<{ id: string }>(
            `SELECT id FROM matches
             WHERE status = 'ACTIVE'
               AND ends_at IS NOT NULL
               AND ends_at < now() - interval '5 minutes'
             LIMIT 50`,
        );

        let completed = 0;
        let mutualForfeited = 0;
        let failed = 0;

        for (const { id: matchId } of expired) {
            try {
                const { rows: fillRows } = await ctx.pool.query<{ count: string }>(
                    `SELECT count(*) FROM orders
                     WHERE match_id = $1 AND status = 'FILLED'`,
                    [matchId],
                );
                const hasFills = parseInt(fillRows[0].count, 10) > 0;

                if (hasFills) {
                    await completeMatch(matchId);
                    completed++;
                } else {
                    await mutualForfeitMatch(matchId);
                    mutualForfeited++;
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg === "match_not_active") {
                    // Benign: a prior or concurrent run already resolved
                    // this match. Not a failure — log info and move on.
                    ctx.logger.info({ matchId }, "match_already_resolved");
                    continue;
                }
                // Real error: log and continue to the next match — one
                // bad match must not break the whole tick (error isolation).
                failed++;
                ctx.logger.error({ matchId, err: msg }, "match_resolution_failed");
            }
        }

        if (pendingCancelled + completed + mutualForfeited + failed > 0) {
            ctx.logger.info(
                { pendingCancelled, completed, mutualForfeited, failed },
                "match_cleanup_done",
            );
        }
    },
};
