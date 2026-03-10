import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { subDays, format, startOfDay } from "date-fns";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { useCompetitionStore } from "@/stores/competitionStore";
import { getSummary, getEquityCurve } from "@/api/endpoints/portfolio";
import { getJournal } from "@/api/endpoints/journal";
import { formatUsd } from "@/lib/decimal";
import type { PortfolioSummary, PortfolioSnapshot } from "@/types/api";
import Card from "@/components/Card";
import Spinner from "@/components/Spinner";
import EmptyState from "@/components/EmptyState";

interface ClosedTrade {
  id: string;
  pair_symbol: string;
  direction: "LONG" | "SHORT";
  entry_avg_price: string;
  exit_avg_price: string;
  net_pnl: string;
  exit_at: string;
}

function pnlColor(value: string): "green" | "red" | "gray" {
  const n = parseFloat(value);
  if (n > 0) return "green";
  if (n < 0) return "red";
  return "gray";
}

function pnlTextColor(value: string): string {
  const n = parseFloat(value);
  if (n > 0) return "text-green-400";
  if (n < 0) return "text-red-400";
  return "text-gray-400";
}

export default function DashboardPage() {
  const { myCompetitions, fetchMyCompetitions } = useCompetitionStore();

  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [recentTrades, setRecentTrades] = useState<ClosedTrade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const results = await Promise.allSettled([
        getSummary(),
        getEquityCurve({ from: subDays(new Date(), 7).toISOString() }),
        getJournal({ limit: 5 }),
      ]);

      if (cancelled) return;

      const [pRes, eqRes, jRes] = results;
      if (pRes.status === "fulfilled") setPortfolio(pRes.value.data.summary);
      if (eqRes.status === "fulfilled") setSnapshots(eqRes.value.data.snapshots);
      if (jRes.status === "fulfilled") setRecentTrades(jRes.value.data.trades ?? []);
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    fetchMyCompetitions();
  }, [fetchMyCompetitions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  // Equity curve chart data
  const equityData = snapshots.map((s) => ({
    ts: new Date(s.ts).getTime(),
    equity: parseFloat(s.equity_quote),
  }));

  // Today's P&L — compare first snapshot of today to current equity
  let todayPnl: number | null = null;
  if (portfolio && snapshots.length > 0) {
    const todayStart = startOfDay(new Date()).getTime();
    const todaySnapshots = snapshots.filter((s) => new Date(s.ts).getTime() >= todayStart);
    if (todaySnapshots.length > 0) {
      const startEquity = parseFloat(todaySnapshots[0]!.equity_quote);
      const currentEquity = parseFloat(portfolio.equity_quote);
      todayPnl = currentEquity - startEquity;
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white">Dashboard</h1>

      {/* Top row — Portfolio stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Equity" value={portfolio ? formatUsd(portfolio.equity_quote) : "—"} />
        <StatCard label="Cash Balance" value={portfolio ? formatUsd(portfolio.cash_quote) : "—"} />
        <StatCard
          label="Unrealized PnL"
          value={portfolio ? formatUsd(portfolio.unrealized_pnl_quote) : "—"}
          color={portfolio ? pnlColor(portfolio.unrealized_pnl_quote) : undefined}
        />
        <StatCard
          label="Net PnL"
          value={portfolio ? formatUsd(portfolio.net_pnl_quote) : "—"}
          color={portfolio ? pnlColor(portfolio.net_pnl_quote) : undefined}
        />
      </div>

      {/* Middle row — Equity Curve + Today's P&L */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Equity Curve */}
        <Card className="lg:col-span-2">
          <h2 className="text-sm font-medium text-gray-400 mb-3">7-Day Equity</h2>
          {equityData.length === 0 ? (
            <EmptyState message="No equity data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={equityData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v: number) => format(new Date(v), "MMM d")}
                  stroke="#6b7280"
                  fontSize={11}
                />
                <YAxis
                  tickFormatter={(v: number) => `$${v.toLocaleString()}`}
                  stroke="#6b7280"
                  fontSize={11}
                  width={70}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1f2937",
                    border: "1px solid #374151",
                    borderRadius: 6,
                  }}
                  labelFormatter={(v) => format(new Date(v as number), "MMM d, HH:mm")}
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

        {/* Today's P&L */}
        <Card className="flex flex-col justify-center items-center">
          <p className="text-xs font-medium text-gray-400 mb-2">Today's P&L</p>
          {todayPnl !== null ? (
            <>
              <p className={`text-3xl font-bold ${todayPnl > 0 ? "text-green-400" : todayPnl < 0 ? "text-red-400" : "text-gray-400"}`}>
                {todayPnl >= 0 ? "+" : ""}{formatUsd(todayPnl.toFixed(2))}
              </p>
              <p className="text-xs text-gray-500 mt-1">since midnight</p>
            </>
          ) : (
            <p className="text-3xl font-bold text-gray-600">—</p>
          )}
        </Card>
      </div>

      {/* Recent Trades */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-400">Recent Trades</h2>
          <Link to="/journal" className="text-xs text-blue-400 hover:text-blue-300">
            View All &rarr;
          </Link>
        </div>
        {recentTrades.length === 0 ? (
          <EmptyState message="No closed trades yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Pair</th>
                  <th className="pb-2 pr-4">Direction</th>
                  <th className="pb-2 pr-4 text-right">Entry</th>
                  <th className="pb-2 pr-4 text-right">Exit</th>
                  <th className="pb-2 pr-4 text-right">Net PnL</th>
                  <th className="pb-2 text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((t) => (
                  <tr key={t.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 font-medium text-gray-200">{t.pair_symbol}</td>
                    <td className="py-2 pr-4">
                      <span className={t.direction === "LONG" ? "text-green-400" : "text-red-400"}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-gray-300">
                      {formatUsd(t.entry_avg_price)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-gray-300">
                      {formatUsd(t.exit_avg_price)}
                    </td>
                    <td className={`py-2 pr-4 text-right font-mono ${pnlTextColor(t.net_pnl)}`}>
                      {formatUsd(t.net_pnl)}
                    </td>
                    <td className="py-2 text-right text-xs text-gray-500">
                      {format(new Date(t.exit_at), "MMM d HH:mm")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Your Competitions */}
      {(myCompetitions ?? []).filter((c) => c.competition_status === "ACTIVE" && c.status === "ACTIVE").length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
              Your Competitions
            </h2>
            <Link to="/competitions" className="text-blue-400 text-xs hover:underline">
              View All
            </Link>
          </div>
          <div className="space-y-3">
            {(myCompetitions ?? [])
              .filter((c) => c.competition_status === "ACTIVE" && c.status === "ACTIVE")
              .map((c) => (
                <Link
                  key={c.competition_id}
                  to={`/competitions/${c.competition_id}`}
                  className="flex items-center justify-between bg-gray-800/50 rounded px-4 py-3 hover:bg-gray-800 transition-colors"
                >
                  <div>
                    <span className="text-white text-sm font-medium">
                      {c.competition_name}
                    </span>
                    {c.final_rank && (
                      <span className="ml-3 text-gray-400 text-xs">
                        Rank #{c.final_rank}
                      </span>
                    )}
                  </div>
                  <span className="text-gray-500 text-xs">
                    Ends {new Date(c.end_at).toLocaleDateString()}
                  </span>
                </Link>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: "green" | "red" | "gray";
}) {
  const colorClass =
    color === "green" ? "text-green-400" :
    color === "red" ? "text-red-400" :
    "text-white";

  return (
    <Card>
      <p className="text-xs font-medium text-gray-400 mb-1">{label}</p>
      <p className={`text-lg font-bold ${colorClass}`}>{value}</p>
    </Card>
  );
}
