import { z } from "zod";
import { proposeChartConfigArgsSchema } from "./toolCalls/proposeChartConfig";

/**
 * Mirrors the `trade_proposals` table (migration 079 + 083 for
 * chart_config + 084 for nullable qty). Co-located here rather than as a
 * `packages/agent-schemas` workspace package — see the Gate 1a plan's
 * deviation note: no agent runner exists yet to be a second consumer, and
 * this repo doesn't currently have a working pnpm workspace for a shared
 * package to live in safely. (That assumption is now stale — Chart
 * Analysis, Gate 1c, is a second consumer — but revisiting the
 * co-location decision is out of scope for this gate.)
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
  // Nullable (migration 084) -- "not yet sized" is a real state, not an
  // omission. An agent with no wallet/balance context (e.g. Chart
  // Analysis, Gate 1c) has no basis to invent a real quantity; Risk Agent
  // (Gate 1d) is expected to populate this when it approves a proposal.
  qty: decimalStr.optional(),
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
  // Gate 1c: suggestion-only chart setup (indicators/timeframe/drawings) a
  // future UI could offer to "apply" -- never a direct store mutation, see
  // the Gate 1c design doc's Q1. Reuses proposeChartConfig's tool-args
  // shape since that's exactly what gets bundled in here.
  chartConfig: proposeChartConfigArgsSchema.optional(),
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
