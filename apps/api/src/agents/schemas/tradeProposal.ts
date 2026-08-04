import { z } from "zod";
import { proposeChartConfigArgsSchema } from "./toolCalls/proposeChartConfig";

/**
 * Mirrors the `trade_proposals` table (migration 079 + 083 for
 * chart_config + 084 for nullable qty + 085 for stop-distance columns).
 * Co-located here rather than as a `packages/agent-schemas` workspace
 * package — see the Gate 1a plan's
 * deviation note: no agent runner exists yet to be a second consumer, and
 * this repo doesn't currently have a working pnpm workspace for a shared
 * package to live in safely. (That assumption is now stale — Chart
 * Analysis, Gate 1c, is a second consumer — but revisiting the
 * co-location decision is out of scope for this gate.)
 */

const decimalStr = z.string().regex(/^\d+(\.\d{1,8})?$/);
// entryPrice/stopPrice/targetPrice must be real, non-zero prices. Without
// this, a model that hits a "no data" wall (e.g. every indicator comes back
// null) can pass schema validation by emitting "0.00000000" for all three --
// literal zeros are indistinguishable from a real proposal downstream, and
// 0/0 arithmetic in computeStopDistance produces a stored NaN. A run with no
// real levels to anchor a proposal to must fail validation, not fabricate
// zeros.
const positiveDecimalStr = decimalStr.refine((v) => Number(v) > 0, {
  message: "must be a positive, non-zero price",
});

export const tradeProposalSchema = z.object({
  pairId: z.string().uuid(),
  agentName: z.string().min(1),
  modelVersion: z.string().optional(),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]),
  tradeType: z.enum(["scalp", "swing"]),
  side: z.enum(["BUY", "SELL"]),
  entryPrice: positiveDecimalStr,
  stopPrice: positiveDecimalStr,
  targetPrice: positiveDecimalStr,
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
  // Nullable: getRegimeTag returns { regime: null, confidence: null } when
  // no regime_tags row exists for a pair yet, and both Scanner and Chart
  // Analysis ask the model to echo these directly in the final JSON, so the
  // model legitimately sends null for either rather than inventing values.
  regime: z.string().nullable().optional(),
  regimeConfidence: z.number().min(0).max(1).nullable().optional(),
  topFeatures: z.record(z.string(), z.unknown()).optional(),
  forecast: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime(),
  // Gate 1c: suggestion-only chart setup (indicators/timeframe/drawings) a
  // future UI could offer to "apply" -- never a direct store mutation, see
  // the Gate 1c design doc's Q1. Reuses proposeChartConfig's tool-args
  // shape since that's exactly what gets bundled in here.
  chartConfig: proposeChartConfigArgsSchema.optional(),
  // Migration 085 -- server-computed from entryPrice/stopPrice (and the
  // last ATR value seen during the run), never asked of the model.
  // Hand-checking real proposals found the model's own self-stated
  // stop-distance arithmetic (e.g. "25bp below entry", "~1.7x ATR") wrong
  // in most cases even though its entry/stop prices themselves were fine
  // -- same "don't let the model assert a number it can get wrong"
  // reasoning as qty (migration 084). stopDistanceAtrMultiple is null
  // whenever the run never called getIndicators with atr in its
  // indicator list.
  //
  // These two fields are the SOLE authoritative source for stop-distance
  // figures. stopReason is illustrative prose only -- do NOT parse it for
  // a numeric distance claim, in this codebase or any future consumer
  // (Risk Agent, UI, reports, etc.). The system prompt asks the model to
  // avoid stating a bp/%/ATR-multiple figure in stopReason, but that's
  // guidance, not an enforced constraint: verified against real
  // post-fix proposals (2026-08-01) that the model still does it
  // sometimes, and when it does, the stated figure can itself be wrong
  // (one observed case: prose said "0.48% risk" while the real,
  // server-computed stopDistancePct was 0.5017% -- the same class of
  // error this migration exists to eliminate). Trust these columns, never
  // the prose.
  stopDistancePct: z.number().nonnegative().optional(),
  stopDistanceAtrMultiple: z.number().nonnegative().optional(),
});

export type TradeProposal = z.infer<typeof tradeProposalSchema>;

export const tradeProposalOutcomeSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "execution_failed",
]);

export type TradeProposalOutcome = z.infer<typeof tradeProposalOutcomeSchema>;
