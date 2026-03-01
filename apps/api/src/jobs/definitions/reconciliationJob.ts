import type { JobDefinition } from "../jobTypes";
import { runFullReconciliation } from "../../reconciliation/reconciliationService";
import { runReconciliation } from "../../reconciliation/reconService";

export const reconciliationJob: JobDefinition = {
    name: "reconciliation",
    intervalSeconds: 300,
    timeoutMs: 60_000,
    async run(ctx) {
        ctx.logger.info("Running scheduled reconciliation");

        // Legacy health/breaker reconciliation
        const report = await runFullReconciliation();
        ctx.logger.info(
            { status: report.overallStatus },
            "Legacy reconciliation complete",
        );

        // PR5: persisted findings + quarantine
        const result = await runReconciliation();
        ctx.logger.info(
            {
                runId: result.runId,
                findings: result.findingsCount,
                high: result.highCount,
                quarantined: result.quarantinedUserIds,
            },
            "Reconciliation findings persisted",
        );
    },
};
