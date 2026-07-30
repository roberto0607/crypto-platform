import { z } from "zod";

/**
 * Mirrors the `trade_proposals` table (migration 079). Co-located here
 * rather than as a `packages/agent-schemas` workspace package — see the
 * Gate 1a plan's deviation note: no agent runner exists yet to be a second
 * consumer, and this repo doesn't currently have a working pnpm workspace
 * for a shared package to live in safely.
 */

const decimalStr = z.string().regex(/^\d+(\.\d{1,8})?$/);

export const tradeProposalSchema = z.object({
  pairId: z.string().uuid(),
  agentName: z.string().min(1),
  modelVersion: z.string().optional(),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]),
  tradeType: z.enum(["scalp", "swing"]),
  side: z.enum(["BUY", "SELL"]),
  entryPrice: decimalStr,
  stopPrice: decimalStr,
  targetPrice: decimalStr,
  qty: decimalStr,
  riskRewardRatio: z.number().positive().optional(),
  confidence: z.number().min(0).max(100),
  entryReason: z.string().min(1),
  stopReason: z.string().min(1),
  targetReason: z.string().min(1),
  regime: z.string().optional(),
  regimeConfidence: z.number().min(0).max(1).optional(),
  topFeatures: z.record(z.string(), z.unknown()).optional(),
  forecast: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime(),
});

export type TradeProposal = z.infer<typeof tradeProposalSchema>;

export const tradeProposalOutcomeSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
]);

export type TradeProposalOutcome = z.infer<typeof tradeProposalOutcomeSchema>;
