import { useState, useEffect } from "react";
import { format } from "date-fns";
import { getPositions, getPnlSummary } from "@/api/endpoints/analytics";
import { useAppStore } from "@/stores/appStore";
import type { Position, PnlSummary } from "@/types/api";
import { formatUsd, formatDecimal } from "@/lib/decimal";
import Card from "@/components/Card";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

function pnlColor(value: string): string {
  const n = parseFloat(value);
  if (n > 0) return "text-green-400";
  if (n < 0) return "text-red-400";
  return "text-gray-400";
}

export default function PositionsPage() {
  const pairs = useAppStore((s) => s.pairs);
  const pairMap = Object.fromEntries(pairs.map((p) => [p.id, p]));

  const [positions, setPositions] = useState<Position[]>([]);
  const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null);
  const [filterPairId, setFilterPairId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = filterPairId ? { pairId: filterPairId } : undefined;

    Promise.allSettled([getPositions(params), getPnlSummary()]).then(
      ([posRes, pnlRes]) => {
        if (cancelled) return;
        if (posRes.status === "fulfilled") {
          setPositions(posRes.value.data.positions);
        } else {
          setError("Failed to load positions");
        }
        if (pnlRes.status === "fulfilled") {
          setPnlSummary(pnlRes.value.data.summary);
        }
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [filterPairId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner message={error} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Positions</h1>
        <div className="flex items-center gap-2">
          <select
            value={filterPairId}
            onChange={(e) => setFilterPairId(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300"
          >
            <option value="">All Pairs</option>
            {pairs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Card>
        {positions.length === 0 ? (
          <EmptyState message="No positions. Place a trade to get started." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-4">Pair</th>
                    <th className="pb-2 pr-4 text-right">Base Qty</th>
                    <th className="pb-2 pr-4 text-right">Avg Entry</th>
                    <th className="pb-2 pr-4 text-right">Current Price</th>
                    <th className="pb-2 pr-4 text-right">Unrealized PnL</th>
                    <th className="pb-2 pr-4 text-right">Realized PnL</th>
                    <th className="pb-2 pr-4 text-right">Fees</th>
                    <th className="pb-2 text-right">Last Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos) => {
                    const pair = pairMap[pos.pair_id];
                    return (
                      <tr
                        key={pos.pair_id}
                        className="border-b border-gray-800/50"
                      >
                        <td className="py-2 pr-4 font-medium">
                          {pair?.symbol ?? pos.pair_id.slice(0, 8)}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {formatDecimal(pos.base_qty, 8)}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {formatUsd(pos.avg_entry_price)}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {formatUsd(pos.current_price)}
                        </td>
                        <td
                          className={`py-2 pr-4 text-right ${pnlColor(pos.unrealized_pnl_quote)}`}
                        >
                          {formatUsd(pos.unrealized_pnl_quote)}
                        </td>
                        <td
                          className={`py-2 pr-4 text-right ${pnlColor(pos.realized_pnl_quote)}`}
                        >
                          {formatUsd(pos.realized_pnl_quote)}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {formatUsd(pos.fees_paid_quote)}
                        </td>
                        <td className="py-2 text-right text-xs text-gray-500">
                          {format(new Date(pos.updated_at), "MMM d HH:mm")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* Summary row */}
                {pnlSummary && (
                  <tfoot>
                    <tr className="border-t border-gray-700 font-medium">
                      <td className="pt-3 pr-4 text-xs text-gray-400" colSpan={4}>
                        Total
                      </td>
                      <td
                        className={`pt-3 pr-4 text-right ${pnlColor(pnlSummary.total_unrealized_pnl)}`}
                      >
                        {formatUsd(pnlSummary.total_unrealized_pnl)}
                      </td>
                      <td
                        className={`pt-3 pr-4 text-right ${pnlColor(pnlSummary.total_realized_pnl)}`}
                      >
                        {formatUsd(pnlSummary.total_realized_pnl)}
                      </td>
                      <td className="pt-3 pr-4 text-right">
                        {formatUsd(pnlSummary.total_fees_paid)}
                      </td>
                      <td className={`pt-3 text-right ${pnlColor(pnlSummary.net_pnl)}`}>
                        Net: {formatUsd(pnlSummary.net_pnl)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
