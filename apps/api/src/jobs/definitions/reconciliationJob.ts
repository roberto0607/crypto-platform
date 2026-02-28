import type { JobDefinition } from "../jobTypes";
import { runFullReconciliation } from "../../reconciliation/reconciliationService";

export const reconciliationJob: JobDefinition = {
    name: "reconciliation",
    intervalSeconds: 300,
    timeoutMs: 30_000,
    async run(ctx) {
        ctx.logger.info("Running scheduled reconciliation");
        const report = await runFullReconciliation();
        ctx.logger.info(
            { status: report.overallStatus },
            "Reconciliation complete"
        );
    },
};
