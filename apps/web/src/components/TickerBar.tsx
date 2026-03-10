import { useAppStore } from "@/stores/appStore";

export default function TickerBar() {
  const pairs = useAppStore((s) => s.pairs);

  const activePairs = pairs.filter((p) => p.is_active && p.last_price);

  if (activePairs.length === 0) return null;

  // Duplicate for seamless scroll
  const items = [...activePairs, ...activePairs];

  return (
    <div className="ticker-bar-wrap">
      <div className="ticker-label-tag">LIVE</div>
      <div className="overflow-hidden flex-1">
        <div className="flex gap-12 whitespace-nowrap animate-ticker-scroll text-[10px] font-mono">
          {items.map((p, i) => {
            const price = parseFloat(p.last_price || "0");
            return (
              <span key={`${p.id}-${i}`} className="flex items-center gap-2">
                <span className="text-white/30 tracking-[2px]">
                  {p.symbol.replace("/", "")}
                </span>
                <span className="text-white">
                  ${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
                {i < items.length - 1 && (
                  <span className="text-white/[0.08] ml-6">|</span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
