import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { formatDecimal } from "@/lib/decimal";
import Badge from "@/components/Badge";

/**
 * A single pair button in the PairSelector — symbol, live price, selected
 * styling, and a Disabled badge.
 *
 * Extracted from PairSelector so each row holds a *scoped* subscription to its
 * own pair's price (`s.prices[pairId]`). In the final state, a BTC tick
 * re-renders only the BTC row, not the whole selector.
 *
 * Click semantics are owned by the child (reads the stable selectPair action
 * from useTradingStore) rather than passed as a callback prop, to keep all
 * props primitive — preserves memoization once added. This sets the precedent
 * for subsequent extractions: stable store actions are read inside the child;
 * only mutable per-row data is passed as primitive props.
 *
 * NOTE: the re-render win is gated on removal of the dual-write scaffold at
 * step 9. While the scaffold lives (useSSE.ts still calls setPairs on every
 * tick, and lib/pairs.ts seeds-without-stripping), PairSelector's `pairs`
 * subscription re-renders the whole selector per tick regardless of this
 * split. (See useSSE.ts:onPriceTick and lib/pairs.ts.)
 */
interface PairSelectorRowProps {
  pairId: string;
  symbol: string;
  tradingEnabled: boolean;
  isSelected: boolean;
}

export default function PairSelectorRow({
  pairId,
  symbol,
  tradingEnabled,
  isSelected,
}: PairSelectorRowProps) {
  const selectPair = useTradingStore((s) => s.selectPair);
  const price = usePairPricesStore((s) => s.prices[pairId]);

  return (
    <button
      onClick={() => selectPair(pairId)}
      className={`flex items-center gap-2 whitespace-nowrap rounded px-3 py-1.5 text-sm transition-colors ${
        isSelected
          ? "bg-gray-800 text-white font-medium"
          : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
      }`}
    >
      <span>{symbol}</span>
      {price !== undefined && (
        <span className="text-xs text-gray-500">{formatDecimal(String(price), 2)}</span>
      )}
      {tradingEnabled === false && <Badge color="red">Disabled</Badge>}
    </button>
  );
}
