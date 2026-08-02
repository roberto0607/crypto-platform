import type { PoolClient } from "pg";
import { agentDecisionSchema, type AgentDecision } from "../schemas";

/**
 * Insert one agent_decisions row (migration 080) within a caller-managed
 * transaction. Client-only (no pool-based variant) -- every current caller
 * (Risk Agent, Gate 1d) writes this as part of a larger atomic evaluation,
 * and a decision log entry that outlives its own transaction's outcome
 * would be misleading.
 */
export async function insertAgentDecisionTx(client: PoolClient, decision: AgentDecision): Promise<void> {
  const parsed = agentDecisionSchema.parse(decision);
  await client.query(
    `INSERT INTO agent_decisions (
       agent_name, pair_id, decision, reasoning, regime, regime_confidence,
       inputs, weights_used, trade_proposal_id, price_at_decision
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
    [
      parsed.agentName,
      parsed.pairId ?? null,
      parsed.decision,
      parsed.reasoning ?? null,
      parsed.regime ?? null,
      parsed.regimeConfidence ?? null,
      parsed.inputs ? JSON.stringify(parsed.inputs) : null,
      parsed.weightsUsed ? JSON.stringify(parsed.weightsUsed) : null,
      parsed.tradeProposalId ?? null,
      parsed.priceAtDecision ?? null,
    ],
  );
}
