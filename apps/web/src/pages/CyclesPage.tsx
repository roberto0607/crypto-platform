import { useAppStore } from "@/stores/appStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import CycleDrawdownTable from "@/components/cycles/CycleDrawdownTable";
import BtcHistoryChart from "@/components/cycles/BtcHistoryChart";

// Cycles — factual Bitcoin cycle-history reference (drawdowns + halvings).
//
// Static dataset (@/lib/btcCycles) + ONE live input: the current BTC price,
// resolved from appStore.pairs by base symbol and read out of pairPricesStore
// (same path TradingPage/TickerItem use). No data API, no AI, no forecasting.
export default function CyclesPage() {
  const pairs = useAppStore((s) => s.pairs);
  const btcPairId = pairs.find((p) => p.symbol.split("/")[0] === "BTC")?.id;
  const currentPrice = usePairPricesStore((s) =>
    btcPairId ? s.prices[btcPairId] : undefined,
  );

  return (
    <div className="font-mono text-white/85 w-full">
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl tracking-[4px] text-tradr-green">CYCLES</h1>
        <span className="text-tradr-green/40">//</span>
      </div>
      <div className="mt-2 text-[10px] tracking-[3px] text-white/30 uppercase">
        Bitcoin cycle history · drawdowns · halvings
      </div>

      <div className="mt-6">
        <CycleDrawdownTable currentPrice={currentPrice} />
      </div>

      <div className="mt-8">
        <BtcHistoryChart currentPrice={currentPrice} />
      </div>

      <div className="mt-6 text-[9px] text-white/25 tracking-[1px] leading-4 max-w-3xl">
        Factual reference — not advice and not a forecast. The ~12–18-month
        post-halving ATH rhythm is an observed pattern across four events, not a law.
      </div>
    </div>
  );
}
