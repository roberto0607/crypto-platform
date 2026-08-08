/**
 * Execution Agent Engine (Gate 1e) -- event-driven trigger for
 * executeTradeProposal, reacting to the Risk Agent's
 * risk_agent.proposal_approved event. Same start/stop-via-subscribeGlobal
 * pattern as riskEngine.ts -- there's nothing to poll for, the triggering
 * event already tells us exactly when a proposal is ready to execute.
 *
 * IMPORTANT: EventHandler is synchronous ((event) => void, not awaited by
 * the bus -- see eventBus.ts's deliverLocally). executeTradeProposal is a
 * real (if fast) DB transaction plus a real order placement, so the
 * handler must fire-and-forget with its own internal error handling,
 * exactly like riskEngine.ts's handler does for its own async calls.
 */
import { subscribeGlobal, unsubscribe, type EventHandler } from "../../events/eventBus";
import { config } from "../../config";
import { logger } from "../../observability/logContext";
import { executeTradeProposal } from "./executor";

let handler: EventHandler | null = null;

async function processApprovedProposal(proposalId: string): Promise<void> {
  try {
    const result = await executeTradeProposal(proposalId);
    if (result.outcome === "skipped") {
      logger.debug({ proposalId, reason: result.reason }, "execution_agent_evaluation_skipped");
    } else {
      logger.info(
        { proposalId, outcome: result.outcome, reason: result.reason, orderId: result.orderId, autoFlattened: result.autoFlattened },
        "execution_agent_evaluation_complete",
      );
    }
  } catch (err) {
    // executeTradeProposal rolls back and rethrows on unexpected failure
    // (e.g. a DB error mid-transaction) -- guard here too so one
    // proposal's failure can't take down the event bus handler.
    logger.error({ proposalId, err }, "execution_agent_evaluation_unexpected_error");
  }
}

export async function startExecutionAgentEngine(): Promise<void> {
  if (handler) return; // already started

  handler = (event) => {
    if (event.type !== "risk_agent.proposal_approved") return;
    if (!config.executionAgentEnabled) return;

    void processApprovedProposal(event.data.proposalId);
  };

  subscribeGlobal(handler);
  logger.info("Execution agent engine started");
}

export function stopExecutionAgentEngine(): void {
  if (handler) {
    unsubscribe(handler);
    handler = null;
    logger.info("Execution agent engine stopped");
  }
}
