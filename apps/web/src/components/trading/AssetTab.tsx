import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { usePairChange } from "@/hooks/usePairChange";

/**
 * A single asset-bar chip — symbol, live price, and 24h change %.
 *
 * Extracted from TradingPage's asset-bar map because the 24h change comes from
 * usePairChange (a hook), and calling a hook inside pairs.map() would violate
 * the Rules of Hooks. Each chip holds scoped subscriptions to its own pair's
 * price + daily-open, so the change derives live from SSE price + cached open.
 *
 * Click semantics are owned by the child (reads the stable selectPair action)
 * to keep all props primitive — the established extraction precedent.
 *
 * Snapshot scoping: only the active tab needs the snapshot (its pair IS the
 * selected pair); non-active tabs select a stable `null`, so they don't
 * re-render on snapshot ticks. The snapshot-first ordering is load-bearing for
 * replay mode — onReplayTick writes snapshot but NOT pairPricesStore, so during
 * a replay session pairPrice holds the stale real-market value while
 * snapshot.last has the replay price. Do not collapse to pairPrice alone.
 *
 * NOTE: the per-tab re-render win is gated on removal of the dual-write
 * scaffold at step 9 AND React.memo (deferred). Until then TradingPage
 * re-renders the whole asset bar per tick (it subscribes to snapshot for the
 * hero price). The extraction is required now for Rules of Hooks regardless.
 */
interface AssetTabProps {
  pairId: string;
  symbol: string;
  isActive: boolean;
}

export default function AssetTab({ pairId, symbol, isActive }: AssetTabProps) {
  const selectPair = useTradingStore((s) => s.selectPair);
  const snapshot = useTradingStore((s) => (isActive ? s.snapshot : null));
  const pairPrice = usePairPricesStore((s) => s.prices[pairId]);
  const change = usePairChange(pairId);

  const price = snapshot?.last ? parseFloat(snapshot.last) : pairPrice ?? 0;
  const changeClass = change === null ? "" : change > 0 ? "up" : change < 0 ? "dn" : "";

  return (
    <div
      className={`tr-asset-tab${isActive ? " active" : ""}`}
      onClick={() => selectPair(pairId)}
    >
      <span>{symbol.split("/")[0]}</span>
      <span className="tr-at-price">
        ${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
      <span className={`tr-at-chg ${changeClass}`}>
        {change === null ? "" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%`}
      </span>
    </div>
  );
}
