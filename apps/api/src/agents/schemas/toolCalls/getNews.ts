import { z } from "zod";

/**
 * Args schema for the Scanner Agent's getNews tool, wrapping
 * apps/api/src/agents/scanner/newsClient.ts's getNewsForPair(pairId).
 */
export const getNewsArgsSchema = z.object({
  pairId: z.string().uuid(),
});

export type GetNewsArgs = z.infer<typeof getNewsArgsSchema>;
