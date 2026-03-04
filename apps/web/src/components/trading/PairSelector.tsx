import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { formatDecimal } from "@/lib/decimal";
import Badge from "@/components/Badge";

export default function PairSelector() {
  const pairs = useAppStore((s) => s.pairs);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const selectPair = useTradingStore((s) => s.selectPair);

  // Default to first pair on mount
  useEffect(() => {
    if (!selectedPairId && pairs.length > 0) {
      selectPair(pairs[0]!.id);
    }
  }, [selectedPairId, pairs, selectPair]);

  if (pairs.length === 0) {
    return <span className="text-sm text-gray-500">No pairs available</span>;
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {pairs.map((pair) => {
        const isSelected = pair.id === selectedPairId;
        return (
          <button
            key={pair.id}
            onClick={() => selectPair(pair.id)}
            className={`flex items-center gap-2 whitespace-nowrap rounded px-3 py-1.5 text-sm transition-colors ${
              isSelected
                ? "bg-gray-800 text-white font-medium"
                : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
            }`}
          >
            <span>{pair.symbol}</span>
            {pair.last_price && (
              <span className="text-xs text-gray-500">
                {formatDecimal(pair.last_price, 2)}
              </span>
            )}
            {pair.trading_enabled === false && <Badge color="red">Disabled</Badge>}
          </button>
        );
      })}
    </div>
  );
}
