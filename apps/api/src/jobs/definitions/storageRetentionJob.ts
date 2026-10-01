import type { JobDefinition } from "../jobTypes";
import { runStorageRetention } from "../../retention/storageRetention";

/**
 * Hourly storage-budget enforcement (see retention/storageRetention.ts).
 * Batched + capped, so a run is bounded even on a backlog; whatever is
 * left is finished by later runs.
 */
export const storageRetentionJob: JobDefinition = {
    name: "storage-retention",
    intervalSeconds: 3600,
    timeoutMs: 600_000,
    maxRunSeconds: 900,
    async run(ctx) {
        await runStorageRetention(ctx.pool, ctx.logger, { batch: { signal: ctx.signal } });
    },
};
