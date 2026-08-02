/**
 * Risk Agent Engine (Gate 1d) -- event-driven trigger for
 * evaluateTradeProposal, reacting to the Chart Analysis Agent's
 * chart_analysis.proposal_created event. Same start/stop-via-subscribeGlobal
 * pattern as chartAnalysisEngine.ts (registered via an app.ts onReady hook +
 * server.ts shutdown) -- there's nothing to poll for, the triggering event
 * already tells us exactly when a new proposal exists.
 *
 * IMPORTANT: EventHandler is synchronous ((event) => void, not awaited by
 * the bus -- see eventBus.ts's deliverLocally). evaluateTradeProposal is a
 * real (if fast) DB transaction, so the handler must fire-and-forget with
 * its own internal error handling, exactly like chartAnalysisEngine.ts's
 * handler does for its own async calls.
 */
import { subscribeGlobal, unsubscribe, type EventHandler } from "../../events/eventBus";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { evaluateTradeProposal } from "./evaluator";

let handler: EventHandler | null = null;

async function processProposal(proposalId: string): Promise<void> {
  try {
    const result = await evaluateTradeProposal(proposalId);
    if (result.decision === "skipped") {
      logger.debug({ proposalId, reason: result.reason }, "risk_agent_evaluation_skipped");
    } else {
      logger.info(
        { proposalId, decision: result.decision, reason: result.reason, qty: result.qty },
        "risk_agent_evaluation_complete",
      );
    }
  } catch (err) {
    // evaluateTradeProposal rolls back and rethrows on unexpected failure
    // (e.g. a DB error mid-transaction) -- guard here too so one proposal's
    // failure can't take down the event bus handler.
    logger.error({ proposalId, err }, "risk_agent_evaluation_unexpected_error");
  }
}

export async function startRiskEngine(): Promise<void> {
  if (handler) return; // already started

  handler = (event) => {
    if (event.type !== "chart_analysis.proposal_created") return;
    if (!config.riskAgentEnabled) return;

    void processProposal(event.data.proposalId);
  };

  subscribeGlobal(handler);
  logger.info("Risk engine started");
}

export function stopRiskEngine(): void {
  if (handler) {
    unsubscribe(handler);
    handler = null;
    logger.info("Risk engine stopped");
  }
}
