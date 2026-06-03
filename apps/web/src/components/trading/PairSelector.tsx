import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import PairSelectorRow from "@/components/trading/PairSelectorRow";

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
      {pairs.map((pair) => (
        <PairSelectorRow
          key={pair.id}
          pairId={pair.id}
          symbol={pair.symbol}
          tradingEnabled={pair.trading_enabled}
          isSelected={pair.id === selectedPairId}
        />
      ))}
    </div>
  );
}
