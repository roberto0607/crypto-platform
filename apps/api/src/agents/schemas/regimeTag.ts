import { z } from "zod";

/** Mirrors the `regime_tags` table (migration 082). */

export const regimeTagSchema = z.object({
  pairId: z.string().uuid(),
  regime: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

export type RegimeTag = z.infer<typeof regimeTagSchema>;
