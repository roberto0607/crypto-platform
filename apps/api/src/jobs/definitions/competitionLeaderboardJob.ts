import type { JobDefinition } from "../jobTypes";
import { listActiveCompetitions } from "../../competitions/competitionRepo";
import { refreshLeaderboard } from "../../competitions/competitionService";
import { getLeaderboard } from "../../competitions/leaderboardRepo";
import { notifyRankChanged } from "../../notifications/notificationService";

export const competitionLeaderboardJob: JobDefinition = {
    name: "competition-leaderboard",
    intervalSeconds: 60,
    timeoutMs: 120_000,
    async run(ctx) {
        const activeComps = await listActiveCompetitions();
        for (const comp of activeComps) {
            try {
                // Snapshot current ranks before refresh
                const oldBoard = await getLeaderboard(comp.id);
                const oldRanks = new Map<string, number>();
                for (const entry of oldBoard) {
                    oldRanks.set(entry.user_id, entry.rank);
                }

                await refreshLeaderboard(comp.id);

                // Check for rank changes after refresh
                const newBoard = await getLeaderboard(comp.id);
                for (const entry of newBoard) {
                    const oldRank = oldRanks.get(entry.user_id);
                    if (oldRank && oldRank !== entry.rank) {
                        notifyRankChanged(
                            entry.user_id,
                            comp.name,
                            comp.id,
                            oldRank,
                            entry.rank,
                        ).catch(() => {});
                    }
                }
            } catch (err) {
                ctx.logger.error(
                    { err, competitionId: comp.id },
                    "leaderboard_refresh_failed",
                );
            }
        }
    },
};
