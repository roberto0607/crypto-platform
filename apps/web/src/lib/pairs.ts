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

export const REAL_BASE_SYMBOLS = ["BTC", "ETH", "SOL"] as const;

const REAL_BASE_SET: ReadonlySet<string> = new Set(REAL_BASE_SYMBOLS);

/** True when the pair's base asset is one of the real, user-facing symbols. */
export function isRealPair(p: { symbol: string }): boolean {
  return REAL_BASE_SET.has(p.symbol.split("/")[0] ?? "");
}
