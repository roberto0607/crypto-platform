/**
 * Trading-pair helpers.
 *
 * The dev DB (and, to a lesser extent, production) contains test fixture
 * pairs with random 5–6 char alphanumeric symbols (HEESTZ, K6MXAK, …)
 * left behind by integration tests and earlier load tests. These should
 * never be shown to users alongside real pairs.
 *
 * Real pairs are filtered by an allowlist of base symbols rather than a
 * blacklist regex — a newly-seeded fixture can never slip through, and
 * the real-pair set is small and stable.
 */

import type { TradingPair, DecimalString } from "@/types/api";
import { usePairPricesStore } from "@/stores/pairPricesStore";

export const REAL_BASE_SYMBOLS = ["BTC", "ETH", "SOL"] as const;

const REAL_BASE_SET: ReadonlySet<string> = new Set(REAL_BASE_SYMBOLS);

/** True when the pair's base asset is one of the real, user-facing symbols. */
export function isRealPair(p: { symbol: string }): boolean {
  return REAL_BASE_SET.has(p.symbol.split("/")[0] ?? "");
}

// Wire shape: server still sends last_price; we use it once to seed
// pairPricesStore, then strip it before storing the typed TradingPair[].
// After this PR, last_price is intentionally absent from the canonical
// TradingPair type — it lives in pairPricesStore as live data, not as a
// stale snapshot on the pair object.
export type TradingPairWire = TradingPair & { last_price?: DecimalString | null };

export function seedAndStripPairs(wirePairs: TradingPairWire[]): TradingPair[] {
  for (const p of wirePairs) {
    if (p.last_price != null) {
      usePairPricesStore.getState().setPairPrice(p.id, parseFloat(p.last_price));
    }
  }
  // Strip last_price before storing the typed TradingPair[]. last_price is
  // intentionally absent from the canonical type — live price lives in
  // pairPricesStore, not as a stale snapshot on the pair object.
  // (Strip activated at step 8 alongside the type field deletion.)
  return wirePairs.map(({ last_price: _last_price, ...rest }) => rest);
}
