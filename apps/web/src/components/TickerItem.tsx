import { usePairPricesStore } from "@/stores/pairPricesStore";

/**
 * A single scrolling ticker entry — one trading pair's symbol + live price.
 *
 * Extracted from TickerBar so each entry holds a *scoped* subscription to its
 * own pair's price (`s.prices[pairId]`). In the final state, a BTC tick
 * re-renders only the BTC TickerItems, not the whole ticker bar.
 *
 * NOTE: that re-render win is gated on removal of the dual-write scaffold at
 * step 9. While the scaffold lives (useSSE.ts still calls setPairs on every
 * tick, and lib/pairs.ts seeds-without-stripping), TickerBar's `pairs`
 * subscription re-renders the whole bar per tick regardless of this split.
 * The extraction is architecturally correct now; the payoff lands when the
 * scaffold dismantles. (See useSSE.ts:onPriceTick and lib/pairs.ts.)
 */
interface TickerItemProps {
  pairId: string;
  symbol: string;
  showSeparator: boolean;
}

export default function TickerItem({ pairId, symbol, showSeparator }: TickerItemProps) {
  const price = usePairPricesStore((s) => s.prices[pairId]);
  return (
    <span className="flex items-center gap-2">
      <span className="text-white/30 tracking-[2px]">{symbol.replace("/", "")}</span>
      <span className="text-white">
        {price !== undefined
          ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
          : "—"}
      </span>
      {showSeparator && <span className="text-white/[0.08] ml-6">|</span>}
    </span>
  );
}
