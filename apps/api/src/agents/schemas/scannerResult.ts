import { z } from "zod";

/**
 * Structured output of the Scanner Agent (Gate 1b Task 4) — a ranked
 * candidate list with supporting context, NOT a tradeProposal. The Scanner
 * never proposes entries/stops/targets; that's Chart Analysis + Risk Agent
 * territory in later gates. Distinct file from tradeProposal.ts, per the
 * design doc's non-goals.
 */
export const scannerCandidateSchema = z.object({
  pairId: z.string().uuid(),
  symbol: z.string().min(1),
  rank: z.number().int().positive(),
  reasoning: z.string().min(1),
  // Nullable: getRegimeTag returns { regime: null, confidence: null } when
  // no regime_tags row exists for a pair yet, and the model legitimately
  // echoes that null rather than inventing a regime string.
  regime: z.string().nullable().optional(),
  supportingDataPoints: z.array(z.string()).default([]),
});

export type ScannerCandidate = z.infer<typeof scannerCandidateSchema>;

export const scannerResultSchema = z.object({
  candidates: z.array(scannerCandidateSchema),
});

export type ScannerResult = z.infer<typeof scannerResultSchema>;
