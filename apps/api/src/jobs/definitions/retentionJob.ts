import type { JobDefinition } from "../jobTypes";
import { runRetention } from "../../retention/retentionService";

export const retentionJob: JobDefinition = {
    name: "retention",
    intervalSeconds: 3600,
    // Deletes are batched + paced now (batchDelete.ts), so a backlog takes
    // longer wall-clock but never holds a long transaction.
    timeoutMs: 600_000,
    maxRunSeconds: 900,
    async run(ctx) {
        await runRetention(ctx.pool, ctx.logger, undefined, { signal: ctx.signal });
    },
};
