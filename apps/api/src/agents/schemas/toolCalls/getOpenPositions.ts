import { z } from "zod";

/**
 * Args schema for a future agent tool reading the `positions` table
 * (apps/api/src/analytics/positionRepo.ts). Scoped to the acting agent's
 * user by the runner, not by this schema — pairId is the only optional
 * filter an agent should be able to request.
 */
export const getOpenPositionsArgsSchema = z.object({
  pairId: z.string().uuid().optional(),
});

export type GetOpenPositionsArgs = z.infer<typeof getOpenPositionsArgsSchema>;
