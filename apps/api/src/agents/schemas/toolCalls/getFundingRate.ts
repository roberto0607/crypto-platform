import { z } from "zod";

/**
 * Args schema for a future agent tool wrapping
 * GET /v1/market/funding-rate (apps/api/src/routes/v1/v1Market.ts).
 * No parameters — that endpoint always returns BTC/ETH/SOL.
 */
export const getFundingRateArgsSchema = z.object({});

export type GetFundingRateArgs = z.infer<typeof getFundingRateArgsSchema>;
