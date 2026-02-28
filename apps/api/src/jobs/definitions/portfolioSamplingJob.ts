import type { JobDefinition } from "../jobTypes";

export const portfolioSamplingJob: JobDefinition = {
    name: "portfolio-sampling",
    intervalSeconds: 300,
    timeoutMs: 60_000,
    async run(ctx) {
        ctx.logger.info("Portfolio sampling job is a placeholder — enable when snapshot-without-fill support is added");
    },
};
