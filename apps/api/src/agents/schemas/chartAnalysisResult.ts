import { z } from "zod";
import { tradeProposalSchema } from "./tradeProposal";

/**
 * The Chart Analysis Agent's terminal JSON output schema (Gate 1c Task 2).
 * Derived from tradeProposalSchema via .omit() rather than redefined, per
 * the "extend, don't duplicate" convention -- omits exactly the fields the
 * runner fills in itself rather than asking the model to invent:
 *  - pairId/agentName/modelVersion: already known by the runner, not the
 *    model's call to make
 *  - topFeatures/forecast: unused by this gate (Chart Analysis has no
 *    feature-store/forecast pipeline behind it, unlike ml_signals)
 *  - expiresAt: the model has no reliable "current time" tool; the runner
 *    computes this from trade_type (scalp/swing expire on different
 *    horizons)
 *  - chartConfig: captured from the proposeChartConfig tool call, not the
 *    final JSON -- keeps the "propose a chart setup" action shaped like a
 *    tool call now, so the interface doesn't change when a later gate
 *    wires it to a real store mutation
 *  - qty: position sizing needs account/balance context this agent
 *    deliberately doesn't have (see the design doc's non-goals -- no
 *    getOpenPositions, no execution tools); asking the model to invent a
 *    quantity would violate the "ground numbers in real tool data" rule.
 *    The runner leaves qty NULL (migration 084 made the column nullable
 *    for exactly this); real sizing is Risk Agent territory (Gate 1d).
 */
export const chartAnalysisResultSchema = tradeProposalSchema.omit({
  pairId: true,
  agentName: true,
  modelVersion: true,
  topFeatures: true,
  forecast: true,
  expiresAt: true,
  chartConfig: true,
  qty: true,
});

export type ChartAnalysisResult = z.infer<typeof chartAnalysisResultSchema>;
