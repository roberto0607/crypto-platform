import { z } from "zod";

/**
 * Args schema for the Scanner Agent's getOpenInterest tool, wrapping
 * GET /v1/market/open-interest (apps/api/src/routes/v1/v1Market.ts).
 * No parameters — that endpoint always returns BTC/ETH/SOL.
 */
export const getOpenInterestArgsSchema = z.object({});

export type GetOpenInterestArgs = z.infer<typeof getOpenInterestArgsSchema>;
