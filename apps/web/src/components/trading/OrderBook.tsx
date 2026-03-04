import { useEffect, useRef } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import { formatDecimal } from "@/lib/decimal";
import Decimal from "decimal.js-light";
import type { OrderBookLevel } from "@/types/api";
import Spinner from "@/components/Spinner";

const POLL_INTERVAL_MS = 2_000;

function maxQty(levels: OrderBookLevel[]): Decimal {
  let max = new Decimal(0);
  for (const lvl of levels) {
    const q = new Decimal(lvl.qty);
    if (q.gt(max)) max = q;
  }
  return max;
}

function Row({
  level,
  maxQ,
  side,
  onClickPrice,
  onClickQty,
}: {
  level: OrderBookLevel;
  maxQ: Decimal;
  side: "bid" | "ask";
  onClickPrice: (price: string) => void;
  onClickQty: (qty: string) => void;
}) {
  const qty = new Decimal(level.qty);
  const price = new Decimal(level.price);
  const total = qty.mul(price);
  const depthPct = maxQ.isZero() ? 0 : qty.div(maxQ).mul(100).toNumber();
  const barColor = side === "bid" ? "bg-green-500/15" : "bg-red-500/15";
  const textColor = side === "bid" ? "text-green-400" : "text-red-400";

  return (
    <tr className="relative text-xs leading-6 hover:bg-gray-800/50 cursor-pointer">
      {/* Depth bar background */}
      <td colSpan={3} className="absolute inset-0 p-0">
        <div
          className={`h-full ${barColor}`}
          style={{ width: `${depthPct}%`, marginLeft: side === "bid" ? "auto" : undefined, marginRight: side === "ask" ? "auto" : undefined }}
        />
      </td>
      <td
        className={`relative px-2 text-right font-mono ${textColor}`}
        onClick={() => onClickPrice(level.price)}
      >
        {formatDecimal(level.price, 2)}
      </td>
      <td
        className="relative px-2 text-right font-mono text-gray-300"
        onClick={() => onClickQty(level.qty)}
      >
        {formatDecimal(level.qty, 6)}
      </td>
      <td className="relative px-2 text-right font-mono text-gray-500">
        {formatDecimal(total.toString(), 2)}
      </td>
    </tr>
  );
}

export default function OrderBook() {
  const orderBook = useTradingStore((s) => s.orderBook);
  const bookLoading = useTradingStore((s) => s.bookLoading);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const refreshBook = useTradingStore((s) => s.refreshBook);
  const setLimitPrice = useTradingStore((s) => s.setLimitPrice);
  const setQty = useTradingStore((s) => s.setQty);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll order book every 2s
  useEffect(() => {
    if (!selectedPairId) return;
    timerRef.current = setInterval(() => {
      refreshBook();
    }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [selectedPairId, refreshBook]);

  if (!selectedPairId) {
    return <div className="text-sm text-gray-500 p-4">Select a pair</div>;
  }

  if (bookLoading && !orderBook) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner size="md" />
      </div>
    );
  }

  if (!orderBook) {
    return <div className="text-sm text-gray-500 p-4">No order book data</div>;
  }

  const asks = [...orderBook.asks].reverse(); // highest ask at top
  const bids = orderBook.bids;

  const askMax = maxQty(asks);
  const bidMax = maxQty(bids);

  // Spread calculation
  const bestAsk = orderBook.asks.length > 0 ? new Decimal(orderBook.asks[0]!.price) : null;
  const bestBid = bids.length > 0 ? new Decimal(bids[0]!.price) : null;
  let spreadText = "";
  if (bestAsk && bestBid) {
    const spread = bestAsk.minus(bestBid);
    const spreadPct = spread.div(bestAsk).mul(100);
    spreadText = `Spread: $${formatDecimal(spread.toString(), 2)} (${spreadPct.toFixed(2)}%)`;
  }

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="text-[10px] uppercase text-gray-500 font-medium px-2 pb-1 tracking-wider">
        Order Book
      </div>

      {/* Asks */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-[10px] uppercase text-gray-500">
              <th className="px-2 text-right font-medium">Price</th>
              <th className="px-2 text-right font-medium">Qty</th>
              <th className="px-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {asks.map((level) => (
              <Row
                key={level.price}
                level={level}
                maxQ={askMax}
                side="ask"
                onClickPrice={setLimitPrice}
                onClickQty={setQty}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Spread */}
      {spreadText && (
        <div className="border-y border-gray-800 px-2 py-1 text-center text-[10px] text-gray-500 font-mono">
          {spreadText}
        </div>
      )}

      {/* Bids */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse">
          <tbody>
            {bids.map((level) => (
              <Row
                key={level.price}
                level={level}
                maxQ={bidMax}
                side="bid"
                onClickPrice={setLimitPrice}
                onClickQty={setQty}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
