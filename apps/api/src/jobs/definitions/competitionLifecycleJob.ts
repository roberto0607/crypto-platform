import type { JobDefinition } from "../jobTypes";
import {
    listUpcomingToActivate,
    listActiveToEnd,
    updateCompetitionStatus,
} from "../../competitions/competitionRepo";
import { finalizeCompetition } from "../../competitions/competitionService";
import { pool } from "../../db/pool";
import { publish } from "../../events/eventBus";
import { createEvent } from "../../events/eventTypes";

export const competitionLifecycleJob: JobDefinition = {
    name: "competition-lifecycle",
    intervalSeconds: 60,
    timeoutMs: 120_000,
    async run(ctx) {
        // Activate upcoming competitions that have passed start_at
        const toActivate = await listUpcomingToActivate();
        for (const comp of toActivate) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await updateCompetitionStatus(client, comp.id, "ACTIVE");
                await client.query("COMMIT");
                ctx.logger.info({ competitionId: comp.id, name: comp.name }, "competition_activated");

                publish(createEvent("competition.started", {
                    competitionId: comp.id,
                    name: comp.name,
                }));
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {});
                ctx.logger.error({ err, competitionId: comp.id }, "competition_activation_failed");
            } finally {
                client.release();
            }
        }

        // End active competitions that have passed end_at
        const toEnd = await listActiveToEnd();
        for (const comp of toEnd) {
            try {
                await finalizeCompetition(comp.id);
                ctx.logger.info({ competitionId: comp.id, name: comp.name }, "competition_ended");

                publish(createEvent("competition.ended", {
                    competitionId: comp.id,
                    name: comp.name,
                }));
            } catch (err) {
                ctx.logger.error({ err, competitionId: comp.id }, "competition_finalization_failed");
            }
        }
    },
};
