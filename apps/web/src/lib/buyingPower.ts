/**
 * Buying power — the order panel's AVAILABLE. Mirror of the server's check
 * (apps/api/src/trading/buyingPower.ts); both are tested on the same cases
 * (apps/api/src/trading/__tests__/buyingPowerCases.json).
 *
 *   buyingPower = (USD balance − USD reserved)
 *               − Σ price × (2 × shortQty + openShortReserve)
 *
 * A short's sale proceeds sit in USD but aren't spendable: 2× its value is
 * held (buy-back + margin), so a $50 short costs the same buying power as a
 * $50 long. Resting sells beyond holdings count 1×. Marked to market, so it
 * moves with price while a short is open, and can go negative.
 */
import Decimal from "decimal.js-light";

export type BpWallet = { assetId: string; balance: string; reserved: string };

const ZERO = new Decimal(0);
const max0 = (d: Decimal) => (d.lt(0) ? ZERO : d);

/** 2 × the short plus resting sells beyond holdings, in base units. */
export function exposureQty(w: Pick<BpWallet, "balance" | "reserved">): Decimal {
  const balance = new Decimal(w.balance);
  const short = max0(balance.neg());
  const openShortReserve = max0(new Decimal(w.reserved).minus(max0(balance)));
  return short.mul(2).plus(openShortReserve);
}

/**
 * Buying power of a wallet set, or null when an asset carrying exposure has
 * no price (unknown — don't show a number that ignores the short).
 */
export function buyingPower(
  quoteAssetId: string,
  wallets: BpWallet[],
  priceOf: (assetId: string) => number | null | undefined,
): number | null {
  let bp = ZERO;
  for (const w of wallets) {
    if (w.assetId === quoteAssetId) {
      bp = bp.plus(new Decimal(w.balance).minus(new Decimal(w.reserved)));
      continue;
    }
    const qty = exposureQty(w);
    if (qty.isZero()) continue;
    const price = priceOf(w.assetId);
    if (!(price && price > 0)) return null;
    bp = bp.minus(qty.mul(price));
  }
  return bp.toNumber();
}
