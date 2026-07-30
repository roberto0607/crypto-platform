import { z } from "zod";

/**
 * Args schema for a future agent tool wrapping
 * GET /v1/market/indicators/:pairId (apps/api/src/routes/v1/v1Market.ts).
 * Key names match tradingStore.ts's IndicatorConfig deliberately.
 */
export const getIndicatorsArgsSchema = z.object({
  pairId: z.string().uuid(),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]).default("1h"),
  indicators: z
    .array(
      z.enum([
        "ema20",
        "ema50",
        "ema200",
        "rsi",
        "atr",
        "macd",
        "bollingerBands",
        "vwap",
        "delta",
        "cvd",
        "vpvr",
      ]),
    )
    .min(1),
});

export type GetIndicatorsArgs = z.infer<typeof getIndicatorsArgsSchema>;
