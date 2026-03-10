import { useEffect, useState, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { listOrders, getOrder } from "@/api/endpoints/trading";
import { formatDecimal } from "@/lib/decimal";
import type { Order, Trade } from "@/types/api";
import Card from "@/components/Card";
import Spinner from "@/components/Spinner";
import Badge from "@/components/Badge";

const PAGE_SIZE = 25;

export default function OrdersTab() {
  const pairs = useAppStore((s) => s.pairs);

  const [orders, setOrders] = useState<Order[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [filterPairId, setFilterPairId] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");

  // Expanded row detail
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTrades, setExpandedTrades] = useState<Trade[]>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);

  const fetchOrders = useCallback(
    async (cursor?: string) => {
      const isMore = !!cursor;
      if (isMore) setLoadingMore(true);
      else setLoading(true);

      try {
        const res = await listOrders({
          pairId: filterPairId || undefined,
          status: filterStatus || undefined,
          cursor: cursor || undefined,
          limit: PAGE_SIZE,
        });
        if (isMore) {
          setOrders((prev) => [...prev, ...res.data.orders]);
        } else {
          setOrders(res.data.orders);
        }
        setNextCursor(res.data.nextCursor);
      } catch {
        // Non-fatal
      }

      if (isMore) setLoadingMore(false);
      else setLoading(false);
    },
    [filterPairId, filterStatus],
  );

  // Refetch on filter change
  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Expand row — fetch order detail with trades
  async function handleExpand(orderId: string) {
    if (expandedId === orderId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(orderId);
    setExpandedLoading(true);
    setExpandedTrades([]);
    try {
      const res = await getOrder(orderId);
      const data = res.data as { order: Order; trades?: Trade[] };
      setExpandedTrades(data.trades ?? []);
    } catch {
      // Non-fatal
    }
    setExpandedLoading(false);
  }

  function pairSymbol(pairId: string): string {
    return pairs.find((p) => p.id === pairId)?.symbol ?? pairId.slice(0, 8);
  }

  function statusColor(status: string): "green" | "yellow" | "red" | "gray" {
    if (status === "FILLED") return "green";
    if (status === "PARTIALLY_FILLED") return "yellow";
    if (status === "CANCELLED") return "red";
    return "gray";
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterPairId}
          onChange={(e) => setFilterPairId(e.target.value)}
          className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 outline-none"
        >
          <option value="">All Pairs</option>
          {pairs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.symbol}
            </option>
          ))}
        </select>

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 outline-none"
        >
          <option value="">All Statuses</option>
          <option value="OPEN">Open</option>
          <option value="PARTIALLY_FILLED">Partially Filled</option>
          <option value="FILLED">Filled</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </div>

      {/* Table */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : orders.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-12">No orders found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-[10px] uppercase text-gray-500 border-b border-gray-800">
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Pair</th>
                  <th className="px-3 py-2 text-left font-medium">Side</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Filled</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    pairSymbol={pairSymbol(order.pair_id)}
                    statusColor={statusColor(order.status)}
                    expanded={expandedId === order.id}
                    expandedTrades={expandedId === order.id ? expandedTrades : []}
                    expandedLoading={expandedId === order.id && expandedLoading}
                    onToggle={() => handleExpand(order.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Load More */}
        {nextCursor && (
          <div className="border-t border-gray-800 p-3 text-center">
            <button
              onClick={() => fetchOrders(nextCursor)}
              disabled={loadingMore}
              className="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50"
            >
              {loadingMore ? <Spinner size="sm" /> : "Load More"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

function OrderRow({
  order,
  pairSymbol,
  statusColor,
  expanded,
  expandedTrades,
  expandedLoading,
  onToggle,
}: {
  order: Order;
  pairSymbol: string;
  statusColor: "green" | "yellow" | "red" | "gray";
  expanded: boolean;
  expandedTrades: Trade[];
  expandedLoading: boolean;
  onToggle: () => void;
}) {
  const isBuy = order.side === "BUY";
  const date = new Date(order.created_at);
  const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const timeStr = date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <tr
        className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-gray-400">
          {dateStr} {timeStr}
        </td>
        <td className="px-3 py-2 text-gray-300 font-medium">{pairSymbol}</td>
        <td className={`px-3 py-2 font-medium ${isBuy ? "text-green-400" : "text-red-400"}`}>
          {order.side}
        </td>
        <td className="px-3 py-2 text-gray-400">{order.type}</td>
        <td className="px-3 py-2 text-right font-mono text-gray-300">
          {order.limit_price ? formatDecimal(order.limit_price, 2) : "MKT"}
        </td>
        <td className="px-3 py-2 text-right font-mono text-gray-300">
          {formatDecimal(order.qty, 6)}
        </td>
        <td className="px-3 py-2 text-right font-mono text-gray-300">
          {formatDecimal(order.qty_filled, 6)}
        </td>
        <td className="px-3 py-2">
          <Badge color={statusColor}>{order.status}</Badge>
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr className="bg-gray-900/50">
          <td colSpan={8} className="px-6 py-3">
            {expandedLoading ? (
              <Spinner size="sm" />
            ) : expandedTrades.length === 0 ? (
              <span className="text-xs text-gray-500">No fills for this order</span>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-gray-500">
                    <th className="px-2 py-1 text-left font-medium">Trade ID</th>
                    <th className="px-2 py-1 text-right font-medium">Price</th>
                    <th className="px-2 py-1 text-right font-medium">Qty</th>
                    <th className="px-2 py-1 text-right font-medium">Quote</th>
                    <th className="px-2 py-1 text-right font-medium">Fee</th>
                    <th className="px-2 py-1 text-left font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {expandedTrades.map((t) => (
                    <tr key={t.id} className="border-t border-gray-800/30">
                      <td className="px-2 py-1 text-gray-500 font-mono">{t.id.slice(0, 8)}</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">
                        {formatDecimal(t.price, 2)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">
                        {formatDecimal(t.qty, 6)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">
                        {formatDecimal(t.quote_amount, 2)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-400">
                        {formatDecimal(t.fee_amount, 4)}
                      </td>
                      <td className="px-2 py-1 text-gray-500">
                        {new Date(t.executed_at).toLocaleTimeString("en-US", { hour12: false })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
