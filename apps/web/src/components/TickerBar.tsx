import { useAppStore } from "@/stores/appStore";
import TickerItem from "@/components/TickerItem";

export default function TickerBar() {
  const pairs = useAppStore((s) => s.pairs);

  // Price-availability is no longer part of the filter — after cold-load
  // seeding + SSE, active pairs have a price; a rare priceless pair (e.g. a
  // freshly-created pair with no trades) renders an em-dash in TickerItem.
  const activePairs = pairs.filter((p) => p.is_active);

  if (activePairs.length === 0) return null;

  // Duplicate for seamless scroll
  const items = [...activePairs, ...activePairs];

  return (
    <div className="ticker-bar-wrap">
      <div className="ticker-label-tag">LIVE</div>
      <div className="overflow-hidden flex-1">
        <div className="flex gap-12 whitespace-nowrap animate-ticker-scroll text-[10px] font-mono">
          {items.map((p, i) => (
            <TickerItem
              key={`${p.id}-${i}`}
              pairId={p.id}
              symbol={p.symbol}
              showSeparator={i < items.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
