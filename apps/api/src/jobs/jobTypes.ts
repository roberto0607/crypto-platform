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
    run: (ctx: JobContext) => Promise<void>;
}
