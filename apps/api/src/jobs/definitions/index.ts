import { reconciliationJob } from "./reconciliationJob";
import { cleanupRefreshTokensJob } from "./cleanupRefreshTokensJob";
import { cleanupReplaySessionsJob } from "./cleanupReplaySessionsJob";
import { cleanupIdempotencyKeysJob } from "./cleanupIdempotencyKeysJob";
import { portfolioSamplingJob } from "./portfolioSamplingJob";
import { retentionJob } from "./retentionJob";
import { cleanupLoginAttemptsJob } from "./cleanupLoginAttemptsJob";
import { cleanupEmailTokensJob } from "./cleanupEmailTokensJob";
import type { JobDefinition } from "../jobTypes";

export const allJobs: JobDefinition[] = [
    reconciliationJob,
    cleanupRefreshTokensJob,
    cleanupReplaySessionsJob,
    cleanupIdempotencyKeysJob,
    portfolioSamplingJob,
    retentionJob,
    cleanupLoginAttemptsJob,
    cleanupEmailTokensJob,
];
