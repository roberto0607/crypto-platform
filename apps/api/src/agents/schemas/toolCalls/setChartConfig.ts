import { z } from "zod";

/**
 * Args schema for a future agent tool that would batch-set indicator
 * toggles, mirroring apps/web/src/stores/tradingStore.ts's
 * `defaultIndicatorConfig`. No `setChartConfig` batch action exists in
 * that store today (only per-key `toggleIndicator`) — this schema is
 * written now so Gate 1b's tool wiring and the store's batch setter can
 * be designed against the same shape; the store-side action itself is
 * frontend work, out of scope here.
 */
export const setChartConfigArgsSchema = z.object({
  ema20: z.boolean().optional(),
  ema50: z.boolean().optional(),
  ema200: z.boolean().optional(),
  vwap: z.boolean().optional(),
  bollingerBands: z.boolean().optional(),
  volume: z.boolean().optional(),
  rsi: z.boolean().optional(),
  macd: z.boolean().optional(),
  atr: z.boolean().optional(),
  delta: z.boolean().optional(),
  keyLevels: z.boolean().optional(),
  liquidityZones: z.boolean().optional(),
  orderBlocks: z.boolean().optional(),
  cvd: z.boolean().optional(),
  fundingRate: z.boolean().optional(),
  openInterest: z.boolean().optional(),
  vpvr: z.boolean().optional(),
  orderbook: z.boolean().optional(),
  footprint: z.boolean().optional(),
  liquidationLevels: z.boolean().optional(),
  cotReport: z.boolean().optional(),
});

export type SetChartConfigArgs = z.infer<typeof setChartConfigArgsSchema>;
