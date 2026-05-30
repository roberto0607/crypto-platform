import type { Pool } from "pg";
import type { Logger } from "pino";

export interface JobContext {
    pool: Pool;
    logger: Logger;
    signal: AbortSignal;
}

export interface JobDefinition {
    name: string;
    intervalSeconds: number;
    timeoutMs?: number;
    /**
     * Worst-case run duration in seconds. A RUNNING row whose last_started_at
     * is older than this is considered crashed (the process died before
     * markFinished could run) and becomes reclaimable by findDueJobs().
     * Should sit comfortably above timeoutMs/1000, since within timeoutMs a
     * run is legitimately alive. Omit to use the default of
     * min(intervalSeconds * 5, 300), computed in jobRepo at query time.
     */
    maxRunSeconds?: number;
    run: (ctx: JobContext) => Promise<void>;
}
