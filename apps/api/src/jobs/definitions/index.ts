import { reconciliationJob } from "./reconciliationJob";
import { cleanupRefreshTokensJob } from "./cleanupRefreshTokensJob";
import { cleanupReplaySessionsJob } from "./cleanupReplaySessionsJob";
import { cleanupIdempotencyKeysJob } from "./cleanupIdempotencyKeysJob";
import { portfolioSamplingJob } from "./portfolioSamplingJob";
import { retentionJob } from "./retentionJob";
import { cleanupLoginAttemptsJob } from "./cleanupLoginAttemptsJob";
import { cleanupEmailTokensJob } from "./cleanupEmailTokensJob";
import { competitionLifecycleJob } from "./competitionLifecycleJob";
import { competitionLeaderboardJob } from "./competitionLeaderboardJob";
import { candleRollupJob } from "./candleRollupJob";
import { weeklyCompetitionJob } from "./weeklyCompetitionJob";
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
    competitionLifecycleJob,
    competitionLeaderboardJob,
    candleRollupJob,
    weeklyCompetitionJob,
];
