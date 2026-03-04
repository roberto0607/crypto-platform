import { useState } from "react";
import Decimal from "decimal.js-light";
import { useTradingStore } from "@/stores/tradingStore";
import { formatDecimal } from "@/lib/decimal";
import Spinner from "@/components/Spinner";

export default function OpenOrders() {
  const openOrders = useTradingStore((s) => s.openOrders);
  const cancelOrder = useTradingStore((s) => s.cancelOrder);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function handleCancel(orderId: string) {
    setCancellingId(orderId);
    try {
      await cancelOrder(orderId);
    } catch {
      // Revert handled in store — just clear spinner
    }
    setCancellingId(null);
  }

  if (openOrders.length === 0) {
    return (
      <div className="text-xs text-gray-500 py-3 text-center">
        No open orders
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-[10px] uppercase text-gray-500 border-b border-gray-800">
            <th className="px-2 py-1.5 text-left font-medium">Side</th>
            <th className="px-2 py-1.5 text-left font-medium">Type</th>
            <th className="px-2 py-1.5 text-right font-medium">Price</th>
            <th className="px-2 py-1.5 text-right font-medium">Qty</th>
            <th className="px-2 py-1.5 text-right font-medium">Filled</th>
            <th className="px-2 py-1.5 text-left font-medium">Status</th>
            <th className="px-2 py-1.5 text-right font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {openOrders.map((order) => {
            const filled = new Decimal(order.qty_filled);
            const total = new Decimal(order.qty);
            const pct = total.isZero() ? 0 : filled.div(total).mul(100).toNumber();
            const isBuy = order.side === "BUY";

            return (
              <tr
                key={order.id}
                className={`border-b border-gray-800/50 hover:bg-gray-800/30 ${
                  isBuy ? "text-green-400" : "text-red-400"
                }`}
              >
                <td className="px-2 py-1.5 font-medium">{order.side}</td>
                <td className="px-2 py-1.5 text-gray-400">{order.type}</td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-300">
                  {order.limit_price ? formatDecimal(order.limit_price, 2) : "MKT"}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-300">
                  {formatDecimal(order.qty, 6)}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="font-mono text-gray-300">
                      {formatDecimal(order.qty_filled, 6)}
                    </span>
                    {/* Mini progress bar */}
                    <div className="w-8 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isBuy ? "bg-green-500" : "bg-red-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-gray-400">{order.status}</td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    onClick={() => handleCancel(order.id)}
                    disabled={cancellingId === order.id}
                    className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    {cancellingId === order.id ? <Spinner size="sm" /> : "Cancel"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
