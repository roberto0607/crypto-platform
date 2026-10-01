import type { LandingSymbol, PriceTick } from "@/hooks/useLandingStream";
import { formatPrice } from "@/lib/landing";

const SYMBOLS: LandingSymbol[] = ["BTC", "ETH", "SOL"];

export default function TickerFooter({ prices }: { prices: Partial<Record<LandingSymbol, PriceTick>> }) {
  const shown = SYMBOLS.filter((s) => prices[s]);
  return (
    <footer className="border-t border-white/10 bg-tradr-bg">
      <ul className="flex flex-wrap items-center gap-x-10 gap-y-2 px-4 md:px-10 min-h-11 py-2 text-[12px]" aria-label="Live prices">
        {shown.map((s) => {
          const tick = prices[s]!;
          return (
            <li key={s} className="flex items-center gap-2 tabular-nums">
              <span className="tracking-[2px] text-lp-muted">{s}</span>
              <span className="text-white">{formatPrice(tick.price)}</span>
              {tick.move && (
                <span className={tick.move === "up" ? "text-lp-accent" : "text-lp-down"} aria-label={tick.move === "up" ? "last tick up" : "last tick down"}>
                  {tick.move === "up" ? "▲" : "▼"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </footer>
  );
}
