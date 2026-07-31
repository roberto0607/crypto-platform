import type { JobDefinition } from "../jobTypes";
import { config } from "../../config.js";
import { runScannerAgent } from "../../agents/scanner/runner.js";
import { publish } from "../../events/eventBus.js";
import { createEvent } from "../../events/eventTypes.js";

/**
 * Interval-based invocation of the Scanner Agent (Gate 1b Task 5). Pure
 * "run every N minutes" -- no price.tick/event reactivity like
 * alertEngine.ts/triggerEngine.ts/matchPnlEngine.ts need, so this is a job
 * (jobRunner.ts's DB-tracked, advisory-locked interval scheduling), not a
 * bespoke setInterval "engine".
 *
 * Registered unconditionally in allJobs (same as marketMakerJob.ts's
 * disableMarketMaker convention) -- the no-op gate lives inside run(), not
 * in whether the job is registered at all.
 */
export const scannerAgentJob: JobDefinition = {
  name: "scanner-agent",
  intervalSeconds: config.scannerAgentIntervalSeconds,
  timeoutMs: 90_000, // MAX_ITERATIONS=8 tool-use round trips in runner.ts, generous headroom
  maxRunSeconds: 120,
  async run(ctx) {
    if (!config.scannerAgentEnabled) return;

    const outcome = await runScannerAgent();
    if (!outcome.result) {
      // Failure/parse-error path -- already recorded to agent_run_logs by
      // runScannerAgent itself. Nothing meaningful to publish.
      return;
    }

    // Events must never break the job -- mirrors alertEngine.ts's
    // publishAlertUpdated() convention.
    try {
      publish(createEvent("scanner.result", { candidates: outcome.result.candidates }));
      ctx.logger.info({ candidateCount: outcome.result.candidates.length }, "scanner_agent_result_published");
    } catch (err) {
      ctx.logger.error({ err }, "scanner_agent_publish_failed");
    }
  },
};
