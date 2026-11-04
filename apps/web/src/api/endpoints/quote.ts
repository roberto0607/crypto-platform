import client from "../client";
import type { DecimalString, OrderSide, UUID } from "@/types/api";

/** GET /v1/sim/quote: what a MARKET order would do right now (api trading/marketQuote.ts). */
export interface MarketQuote {
  executable: boolean;
  /** Why not: order_too_large, book_stale_for_size or stale_price_source. */
  reason: string | null;
  qty: DecimalString;
  touchPrice: DecimalString;
  /** Average fill. */
  estimatedPrice: DecimalString;
  slippage_bps: DecimalString;
  slippageQuote: DecimalString;
  /** qty × average fill. */
  requestedNotional: DecimalString;
  feeQuote: DecimalString;
  maxOrderNotional: DecimalString;
}

/** Exactly one of qty / budget. `budget` asks the server for the largest qty that margin can open. */
export interface QuoteParams {
  pairId: UUID;
  side: OrderSide;
  qty?: DecimalString;
  budget?: DecimalString;
  leverage?: number;
  reduces?: boolean;
}

export function getMarketQuote(params: QuoteParams, signal?: AbortSignal) {
  return client.get<MarketQuote>("/v1/sim/quote", { params, signal });
}
