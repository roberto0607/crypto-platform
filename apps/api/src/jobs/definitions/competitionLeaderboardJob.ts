import type { JobDefinition } from "../jobTypes";
import { listActiveCompetitions } from "../../competitions/competitionRepo";
import { refreshLeaderboard } from "../../competitions/competitionService";

export const competitionLeaderboardJob: JobDefinition = {
    name: "competition-leaderboard",
    intervalSeconds: 60,
    timeoutMs: 120_000,
    async run(ctx) {
        const activeComps = await listActiveCompetitions();
        for (const comp of activeComps) {
            try {
                await refreshLeaderboard(comp.id);
            } catch (err) {
                ctx.logger.error(
                    { err, competitionId: comp.id },
                    "leaderboard_refresh_failed",
                );
            }
        }
    },
};
