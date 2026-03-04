import { useTradingStore } from "@/stores/tradingStore";
import { formatDecimal } from "@/lib/decimal";

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function RecentTrades() {
  const recentTrades = useTradingStore((s) => s.recentTrades);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="text-[10px] uppercase text-gray-500 font-medium px-2 pb-1 tracking-wider">
        Recent Trades
      </div>

      {/* Header */}
      <div className="grid grid-cols-3 px-2 py-1 text-[10px] uppercase text-gray-500 font-medium">
        <span>Price</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Time</span>
      </div>

      {/* Trade list */}
      <div className="flex-1 overflow-y-auto">
        {recentTrades.length === 0 ? (
          <div className="text-center text-gray-600 py-4">
            Waiting for trades...
          </div>
        ) : (
          recentTrades.map((trade) => {
            const isBuy = trade.side === "BUY";
            return (
              <div
                key={trade.tradeId}
                className="grid grid-cols-3 px-2 py-0.5 font-mono hover:bg-gray-800/30"
              >
                <span className={isBuy ? "text-green-400" : "text-red-400"}>
                  {formatDecimal(trade.price, 2)}
                </span>
                <span className="text-right text-gray-300">
                  {formatDecimal(trade.qty, 6)}
                </span>
                <span className="text-right text-gray-500">
                  {formatTime(trade.ts)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
