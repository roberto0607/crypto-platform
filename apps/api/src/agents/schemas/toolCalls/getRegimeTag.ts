import { z } from "zod";

/**
 * Args schema for the Scanner Agent's getRegimeTag tool — reads the latest
 * regime_tags row (migration 082) for a pair, written by
 * apps/api/src/agents/scanner/regimeClassifier.ts.
 */
export const getRegimeTagArgsSchema = z.object({
  pairId: z.string().uuid(),
});

export type GetRegimeTagArgs = z.infer<typeof getRegimeTagArgsSchema>;
