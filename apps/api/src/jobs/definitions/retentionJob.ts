import type { JobDefinition } from "../jobTypes";
import { runRetention } from "../../retention/retentionService";

export const retentionJob: JobDefinition = {
    name: "retention",
    intervalSeconds: 3600,
    timeoutMs: 120_000,
    async run(ctx) {
        await runRetention(ctx.pool, ctx.logger);
    },
};
