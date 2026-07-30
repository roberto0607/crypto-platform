import { z } from "zod";

/** Mirrors the `agent_decisions` table (migration 080). */

export const agentDecisionSchema = z.object({
  agentName: z.string().min(1),
  pairId: z.string().uuid().optional(),
  decision: z.string().min(1),
  reasoning: z.string().optional(),
  regime: z.string().optional(),
  regimeConfidence: z.number().min(0).max(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  weightsUsed: z.record(z.string(), z.unknown()).optional(),
  tradeProposalId: z.string().uuid().optional(),
  priceAtDecision: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;
