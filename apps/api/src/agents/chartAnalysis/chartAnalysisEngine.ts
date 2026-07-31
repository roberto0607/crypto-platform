/**
 * Chart Analysis Engine (Gate 1c Task 3) — event-driven trigger for the
 * Chart Analysis Agent, reacting to the Scanner Agent's scanner.result
 * event rather than polling agent_run_logs/job_runs on an interval.
 *
 * Recon for the Gate 1c design doc's Q2 confirmed eventBus.ts supports a
 * genuine in-process subscription (subscribeGlobal) -- the same pattern
 * already used by triggerEngine.ts/alertEngine.ts/matchPnlEngine.ts. This
 * module follows that convention (start/stop pair registered via an
 * app.ts onReady hook + server.ts shutdown) rather than being registered
 * as an interval JobDefinition in jobs/definitions/index.ts, since there
 * is nothing to poll for -- scanner.result already tells us exactly when
 * new work exists.
 *
 * IMPORTANT: EventHandler is synchronous ((event) => void, not awaited by
 * the bus -- see eventBus.ts's deliverLocally). Each candidate's LLM call
 * takes real wall-clock time, so the handler must fire-and-forget
 * (`void processShortlist(...).catch(...)`) with its own internal error
 * handling, exactly like triggerEngine.ts's handler does for its own
 * async evaluateTriggersForPair calls.
 */
import { subscribeGlobal, unsubscribe, type EventHandler } from "../../events/eventBus";
import type { ScannerCandidateData } from "../../events/eventTypes";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { runChartAnalysisAgent } from "./runner";

let handler: EventHandler | null = null;

/**
 * Runs the Chart Analysis Agent once per candidate, sequentially (not
 * parallel) -- these are real Anthropic API calls with real cost, and the
 * shortlist is already cost-bounded by Scanner (~8 candidates), so there's
 * no throughput need to justify concurrent API calls here.
 */
async function processShortlist(candidates: ScannerCandidateData[]): Promise<void> {
  for (const candidate of candidates) {
    try {
      const outcome = await runChartAnalysisAgent(candidate);
      if (outcome.error) {
        logger.warn(
          { pairId: candidate.pairId, symbol: candidate.symbol, err: outcome.error },
          "chart_analysis_agent_run_failed",
        );
      } else {
        logger.info(
          { pairId: candidate.pairId, symbol: candidate.symbol, proposalId: outcome.proposalId },
          "chart_analysis_agent_run_succeeded",
        );
      }
    } catch (err) {
      // runChartAnalysisAgent itself never throws (see its own try/catch),
      // but guard here too -- one candidate's unexpected failure must not
      // stop the rest of the shortlist from being processed.
      logger.error({ pairId: candidate.pairId, symbol: candidate.symbol, err }, "chart_analysis_agent_unexpected_error");
    }
  }
}

/**
 * Bootstrap: subscribe to the event bus for scanner.result events.
 */
export async function startChartAnalysisEngine(): Promise<void> {
  if (handler) return; // already started

  handler = (event) => {
    if (event.type !== "scanner.result") return;
    if (!config.chartAnalysisAgentEnabled) return;

    void processShortlist(event.data.candidates).catch((err) => {
      logger.error({ err }, "chart_analysis_engine_process_shortlist_error");
    });
  };

  subscribeGlobal(handler);
  logger.info("Chart analysis engine started");
}

/**
 * Teardown: unsubscribe from the event bus.
 */
export function stopChartAnalysisEngine(): void {
  if (handler) {
    unsubscribe(handler);
    handler = null;
    logger.info("Chart analysis engine stopped");
  }
}
