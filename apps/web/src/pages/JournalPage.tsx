import { useEffect, useState, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { getJournal, getJournalSummary, exportJournalCsv } from "@/api/endpoints/journal";
import { formatUsd, formatPct } from "@/lib/decimal";
import Card from "@/components/Card";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

interface ClosedTrade {
  id: string;
  pair_symbol: string;
  direction: "LONG" | "SHORT";
  entry_avg_price: string;
  exit_avg_price: string;
  entry_qty: string;
  gross_pnl: string;
  total_fees: string;
  net_pnl: string;
  return_pct: string;
  holding_seconds: number;
  exit_at: string;
}

interface JournalSummaryData {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: string;
  totalGrossPnl: string;
  totalFees: string;
  totalNetPnl: string;
  avgWin: string;
  avgLoss: string;
  largestWin: string;
  largestLoss: string;
  avgHoldingSeconds: number;
  profitFactor: string;
}

type DirectionFilter = "" | "LONG" | "SHORT";
type PnlFilter = "" | "positive" | "negative";

function pnlColor(value: string): string {
  const n = parseFloat(value);
  if (n > 0) return "text-green-400";
  if (n < 0) return "text-red-400";
  return "text-gray-400";
}

function formatHoldTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function SummaryCard({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) {
  return (
    <Card>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-base font-semibold ${colorClass ?? "text-gray-100"}`}>{value}</p>
    </Card>
  );
}

export default function JournalPage() {
  const pairs = useAppStore((s) => s.pairs);
  const activeCompetitionId = useTradingStore((s) => s.activeCompetitionId);

  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [summary, setSummary] = useState<JournalSummaryData | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [pairFilter, setPairFilter] = useState("");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("");
  const [pnlFilter, setPnlFilter] = useState<PnlFilter>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params: Record<string, string | number> = {};
      if (pairFilter) params.pairId = pairFilter;
      if (dirFilter) params.direction = dirFilter;
      if (pnlFilter) params.pnlSign = pnlFilter;

      const [journalRes, summaryRes] = await Promise.all([
        getJournal(params),
        getJournalSummary(pairFilter || undefined),
      ]);

      setTrades(journalRes.data.trades);
      setNextCursor(journalRes.data.nextCursor);
      setSummary(summaryRes.data.summary);
    } catch {
      setError("Failed to load journal data");
    } finally {
      setLoading(false);
    }
  }, [pairFilter, dirFilter, pnlFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData, activeCompetitionId]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);

    try {
      const params: Record<string, string | number> = { cursor: nextCursor };
      if (pairFilter) params.pairId = pairFilter;
      if (dirFilter) params.direction = dirFilter;
      if (pnlFilter) params.pnlSign = pnlFilter;

      const res = await getJournal(params);
      setTrades((prev) => [...prev, ...res.data.trades]);
      setNextCursor(res.data.nextCursor);
    } catch {
      // Non-fatal
    } finally {
      setLoadingMore(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await exportJournalCsv();
      const blob = new Blob([res.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "trade-journal.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Non-fatal
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) return <ErrorBanner message={error} />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Trade Journal</h1>

      {activeCompetitionId && (
        <div className="bg-blue-900/20 border border-blue-800 rounded px-4 py-2">
          <span className="text-blue-400 text-sm">Showing journal for competition context</span>
        </div>
      )}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <SummaryCard label="Total Trades" value={String(summary.totalTrades)} />
          <SummaryCard
            label="Win Rate"
            value={`${summary.winRate}%`}
            colorClass={parseFloat(summary.winRate) >= 50 ? "text-green-400" : "text-red-400"}
          />
          <SummaryCard
            label="Net P&L"
            value={formatUsd(summary.totalNetPnl)}
            colorClass={pnlColor(summary.totalNetPnl)}
          />
          <SummaryCard label="Profit Factor" value={summary.profitFactor} />
          <SummaryCard
            label="Avg Win"
            value={formatUsd(summary.avgWin)}
            colorClass="text-green-400"
          />
          <SummaryCard
            label="Avg Loss"
            value={formatUsd(summary.avgLoss)}
            colorClass="text-red-400"
          />
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={pairFilter}
          onChange={(e) => setPairFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200"
        >
          <option value="">All Pairs</option>
          {pairs.map((p) => (
            <option key={p.id} value={p.id}>{p.symbol}</option>
          ))}
        </select>

        <select
          value={dirFilter}
          onChange={(e) => setDirFilter(e.target.value as DirectionFilter)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200"
        >
          <option value="">All Directions</option>
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>

        <select
          value={pnlFilter}
          onChange={(e) => setPnlFilter(e.target.value as PnlFilter)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200"
        >
          <option value="">All Trades</option>
          <option value="positive">Winners</option>
          <option value="negative">Losers</option>
        </select>

        <button
          onClick={handleExport}
          className="ml-auto bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
        >
          Export CSV
        </button>
      </div>

      {/* Trade Journal Table */}
      <Card>
        {trades.length === 0 ? (
          <EmptyState message="No closed trades yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Pair</th>
                  <th className="pb-2 pr-4">Dir</th>
                  <th className="pb-2 pr-4 text-right">Entry</th>
                  <th className="pb-2 pr-4 text-right">Exit</th>
                  <th className="pb-2 pr-4 text-right">Qty</th>
                  <th className="pb-2 pr-4 text-right">Gross P&L</th>
                  <th className="pb-2 pr-4 text-right">Fees</th>
                  <th className="pb-2 pr-4 text-right">Net P&L</th>
                  <th className="pb-2 pr-4 text-right">Return %</th>
                  <th className="pb-2 text-right">Hold Time</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 text-gray-300">
                      {new Date(t.exit_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 font-medium">{t.pair_symbol}</td>
                    <td className="py-2 pr-4">
                      <span className={t.direction === "LONG" ? "text-green-400" : "text-red-400"}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right">{formatUsd(t.entry_avg_price)}</td>
                    <td className="py-2 pr-4 text-right">{formatUsd(t.exit_avg_price)}</td>
                    <td className="py-2 pr-4 text-right">{parseFloat(t.entry_qty).toFixed(6)}</td>
                    <td className={`py-2 pr-4 text-right ${pnlColor(t.gross_pnl)}`}>
                      {formatUsd(t.gross_pnl)}
                    </td>
                    <td className="py-2 pr-4 text-right text-gray-400">
                      {formatUsd(t.total_fees)}
                    </td>
                    <td className={`py-2 pr-4 text-right font-medium ${pnlColor(t.net_pnl)}`}>
                      {formatUsd(t.net_pnl)}
                    </td>
                    <td className={`py-2 pr-4 text-right ${pnlColor(t.return_pct)}`}>
                      {formatPct(t.return_pct)}
                    </td>
                    <td className="py-2 text-right text-gray-400">
                      {formatHoldTime(t.holding_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="mt-4 text-center">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="px-4 py-2 text-sm bg-gray-800 border border-gray-700 rounded hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : "Load More"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
