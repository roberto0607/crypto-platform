/**
 * Trading-pair helpers.
 *
 * Test fixture pairs (random 5–6 char alphanumeric symbols like HEESTZ,
 * K6MXAK, left behind by integration tests and load tests) used to require
 * a client-side allowlist (REAL_BASE_SYMBOLS, now removed) since they could
 * leak into the DB as is_active = true. GET /pairs now filters server-side
 * on exchange_symbol_map (only pairs with a live Kraken/Coinbase mapping
 * are ever returned — see pairRepo.ts's listActivePairsForDisplay()), so
 * fixture pairs are excluded before they reach the client regardless of
 * their is_active state.
 */

import type { TradingPair, DecimalString } from "@/types/api";
import { usePairPricesStore } from "@/stores/pairPricesStore";

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

// ── Initial pair selection ──
//
// The server only ever returns MARKET_SYMBOLS pairs (BTC/ETH/SOL), so the
// `pairs` list a page already holds IS the allowed list — no client-side
// copy of the allowlist to drift. The user's last pick is remembered by
// SYMBOL (not id) so it survives a DB reseed, and is honored only if it's
// still in that list; otherwise BTC/USD, then whatever comes first.

export const LAST_PAIR_STORAGE_KEY = "tradr_last_pair";
export const DEFAULT_PAIR_SYMBOL = "BTC/USD";

export function readLastPairSymbol(): string | null {
  try {
    return localStorage.getItem(LAST_PAIR_STORAGE_KEY);
  } catch {
    return null; // storage blocked (private mode etc.) — fall back to default
  }
}

export function rememberPairSymbol(symbol: string): void {
  try {
    localStorage.setItem(LAST_PAIR_STORAGE_KEY, symbol);
  } catch {
    // best-effort convenience only
  }
}

export function pickInitialPairId(
  pairs: readonly Pick<TradingPair, "id" | "symbol">[],
  lastSymbol: string | null = readLastPairSymbol(),
): string | null {
  const bySymbol = (s: string | null) => (s ? pairs.find((p) => p.symbol === s) : undefined);
  return (bySymbol(lastSymbol) ?? bySymbol(DEFAULT_PAIR_SYMBOL) ?? pairs[0])?.id ?? null;
}
