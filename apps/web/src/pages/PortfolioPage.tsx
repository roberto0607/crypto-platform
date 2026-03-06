import { useState, useEffect, useCallback } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { format, subDays, subMonths } from "date-fns";
import { getSummary, getEquityCurve, getPerformance } from "@/api/endpoints/portfolio";
import { getPositions } from "@/api/endpoints/analytics";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import type {
  PortfolioSummary,
  PortfolioSnapshot,
  PerformanceSummary,
  Position,
} from "@/types/api";
import { formatUsd, formatPct, formatDecimal } from "@/lib/decimal";
import Card from "@/components/Card";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

type TimeRange = "1D" | "1W" | "1M" | "3M" | "ALL";

function rangeToFrom(range: TimeRange): string | undefined {
  const now = new Date();
  switch (range) {
    case "1D":
      return subDays(now, 1).toISOString();
    case "1W":
      return subDays(now, 7).toISOString();
    case "1M":
      return subMonths(now, 1).toISOString();
    case "3M":
      return subMonths(now, 3).toISOString();
    case "ALL":
      return undefined;
  }
}

function pnlColor(value: string): string {
  const n = parseFloat(value);
  if (n > 0) return "text-green-400";
  if (n < 0) return "text-red-400";
  return "text-gray-400";
}

function SummaryCard({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: string;
  colorClass?: string;
}) {
  return (
    <Card>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-base font-semibold ${colorClass ?? "text-gray-100"}`}>
        {value}
      </p>
    </Card>
  );
}

export default function PortfolioPage() {
  const pairs = useAppStore((s) => s.pairs);
  const activeCompetitionId = useTradingStore((s) => s.activeCompetitionId);

  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [performance, setPerformance] = useState<PerformanceSummary | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [timeRange, setTimeRange] = useState<TimeRange>("1M");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pairMap = Object.fromEntries(pairs.map((p) => [p.id, p]));

  // Load summary, performance, positions on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const compId = activeCompetitionId ?? undefined;
    Promise.allSettled([
      getSummary(activeCompetitionId),
      getPerformance({ competitionId: compId }),
      getPositions(),
    ]).then(
      ([sumRes, perfRes, posRes]) => {
        if (cancelled) return;
        if (sumRes.status === "fulfilled") setSummary(sumRes.value.data.summary);
        if (perfRes.status === "fulfilled")
          setPerformance(perfRes.value.data.performance);
        if (posRes.status === "fulfilled")
          setPositions(posRes.value.data.positions);
        if (
          sumRes.status === "rejected" &&
          perfRes.status === "rejected" &&
          posRes.status === "rejected"
        ) {
          setError("Failed to load portfolio data");
        }
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [activeCompetitionId]);

  // Load equity curve when time range changes
  const loadEquity = useCallback(async (range: TimeRange) => {
    try {
      const from = rangeToFrom(range);
      const compId = activeCompetitionId ?? undefined;
      const res = await getEquityCurve({ from: from ?? undefined, competitionId: compId });
      setSnapshots(res.data.snapshots);
    } catch {
      // Non-fatal — chart just stays empty
    }
  }, [activeCompetitionId]);

  useEffect(() => {
    loadEquity(timeRange);
  }, [timeRange, loadEquity]);

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

  const equityData = snapshots.map((s) => ({
    ts: new Date(s.ts).getTime(),
    equity: parseFloat(s.equity_quote),
  }));

  const drawdownData = (performance?.drawdown_series ?? []).map((d) => ({
    ts: new Date(d.ts).getTime(),
    drawdown: parseFloat(d.drawdown_pct),
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Portfolio</h1>

      {activeCompetitionId && (
        <div className="bg-blue-900/20 border border-blue-800 rounded px-4 py-2">
          <span className="text-blue-400 text-sm">
            Showing portfolio for competition context
          </span>
        </div>
      )}

      {/* Section 1: Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <SummaryCard label="Total Equity" value={formatUsd(summary.equity_quote)} />
          <SummaryCard label="Cash" value={formatUsd(summary.cash_quote)} />
          <SummaryCard label="Holdings" value={formatUsd(summary.holdings_quote)} />
          <SummaryCard
            label="Unrealized PnL"
            value={formatUsd(summary.unrealized_pnl_quote)}
            colorClass={pnlColor(summary.unrealized_pnl_quote)}
          />
          <SummaryCard
            label="Realized PnL"
            value={formatUsd(summary.realized_pnl_quote)}
            colorClass={pnlColor(summary.realized_pnl_quote)}
          />
          <SummaryCard
            label="Net PnL"
            value={formatUsd(summary.net_pnl_quote)}
            colorClass={pnlColor(summary.net_pnl_quote)}
          />
          <SummaryCard label="Fees Paid" value={formatUsd(summary.fees_paid_quote)} />
        </div>
      )}

      {/* Section 2: Equity Curve */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Equity Curve</h2>
          <div className="flex gap-1">
            {(["1D", "1W", "1M", "3M", "ALL"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  timeRange === r
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        {equityData.length === 0 ? (
          <EmptyState message="No equity data for this period" />
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={equityData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => format(new Date(v), "MMM d")}
                stroke="#6b7280"
                fontSize={12}
              />
              <YAxis
                tickFormatter={(v: number) => `$${v.toLocaleString()}`}
                stroke="#6b7280"
                fontSize={12}
                width={80}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: 6,
                }}
                labelFormatter={(v) =>
                  format(new Date(v as number), "MMM d, yyyy HH:mm")
                }
                formatter={(v) => [
                  `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                  "Equity",
                ]}
              />
              <Line
                type="monotone"
                dataKey="equity"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "#3b82f6" }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Section 3: Performance Metrics */}
      {performance && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <h2 className="text-sm font-medium text-gray-300 mb-3">Performance</h2>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-gray-500">Total Return</p>
                <p
                  className={`text-lg font-semibold ${pnlColor(performance.total_return_pct)}`}
                >
                  {formatPct(performance.total_return_pct)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Max Drawdown</p>
                <p className="text-lg font-semibold text-red-400">
                  {formatPct(performance.max_drawdown_pct)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Current Drawdown</p>
                <p className="text-lg font-semibold text-red-400">
                  {formatPct(performance.current_drawdown_pct)}
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="text-sm font-medium text-gray-300 mb-3">Drawdown</h2>
            {drawdownData.length === 0 ? (
              <EmptyState message="No drawdown data" />
            ) : (
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={drawdownData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(v: number) => format(new Date(v), "MMM d")}
                    stroke="#6b7280"
                    fontSize={12}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                    stroke="#6b7280"
                    fontSize={12}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1f2937",
                      border: "1px solid #374151",
                      borderRadius: 6,
                    }}
                    labelFormatter={(v) =>
                      format(new Date(v as number), "MMM d, yyyy")
                    }
                    formatter={(v) => [`${Number(v).toFixed(2)}%`, "Drawdown"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="drawdown"
                    stroke="#ef4444"
                    fill="#ef4444"
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>
      )}

      {/* Section 4: Positions Table */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">Positions</h2>
        {positions.length === 0 ? (
          <EmptyState message="No open positions" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Pair</th>
                  <th className="pb-2 pr-4">Side</th>
                  <th className="pb-2 pr-4 text-right">Qty</th>
                  <th className="pb-2 pr-4 text-right">Avg Entry</th>
                  <th className="pb-2 pr-4 text-right">Current Price</th>
                  <th className="pb-2 pr-4 text-right">Unrealized PnL</th>
                  <th className="pb-2 pr-4 text-right">Realized PnL</th>
                  <th className="pb-2 text-right">Fees</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const pair = pairMap[pos.pair_id];
                  const side = parseFloat(pos.base_qty) >= 0 ? "LONG" : "SHORT";
                  return (
                    <tr
                      key={pos.pair_id}
                      className="border-b border-gray-800/50"
                    >
                      <td className="py-2 pr-4 font-medium">
                        {pair?.symbol ?? pos.pair_id}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={
                            side === "LONG" ? "text-green-400" : "text-red-400"
                          }
                        >
                          {side}
                        </span>
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
                      <td className="py-2 text-right">
                        {formatUsd(pos.fees_paid_quote)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
