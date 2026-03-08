import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useCompetitionStore } from "@/stores/competitionStore";
import { getSummary } from "@/api/endpoints/portfolio";
import { listOrders } from "@/api/endpoints/trading";
import { listTriggers } from "@/api/endpoints/triggers";
import { formatUsd } from "@/lib/decimal";
import type { PortfolioSummary } from "@/types/api";
import Card from "@/components/Card";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";

function pnlColor(value: string): "green" | "red" | "gray" {
  const n = parseFloat(value);
  if (n > 0) return "green";
  if (n < 0) return "red";
  return "gray";
}

export default function DashboardPage() {
  const wallets = useAppStore((s) => s.wallets);
  const riskStatus = useAppStore((s) => s.riskStatus);
  const userStatus = useAppStore((s) => s.userStatus);
  const { myCompetitions, fetchMyCompetitions } = useCompetitionStore();

  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [openOrderCount, setOpenOrderCount] = useState<number | null>(null);
  const [activeTriggerCount, setActiveTriggerCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const results = await Promise.allSettled([
        getSummary(),
        listOrders({ status: "OPEN", limit: 100 }),
        listTriggers({ status: "ACTIVE", limit: 100 }),
      ]);

      if (cancelled) return;

      const [pRes, oRes, tRes] = results;
      if (pRes.status === "fulfilled") setPortfolio(pRes.value.data.summary);
      if (oRes.status === "fulfilled") setOpenOrderCount(oRes.value.data.orders.length);
      if (tRes.status === "fulfilled") setActiveTriggerCount(tRes.value.data.triggers.length);
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

  const tradingAllowed = riskStatus?.trading_allowed ?? true;
  const breakers = riskStatus?.breakers ?? [];

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

      {/* Middle row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Wallets */}
        <Card className="lg:col-span-1">
          <h2 className="text-sm font-medium text-gray-400 mb-3">Wallets</h2>
          {wallets.length === 0 ? (
            <p className="text-sm text-gray-500">No wallets yet</p>
          ) : (
            <div className="space-y-2">
              {wallets.map((w) => (
                <div key={w.id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-300 font-medium">{w.symbol ?? "—"}</span>
                  <div className="text-right">
                    <span className="text-gray-100">{w.balance}</span>
                    {parseFloat(w.reserved) > 0 && (
                      <span className="text-gray-500 ml-2">({w.reserved} reserved)</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Open Orders */}
        <Card>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Open Orders</h2>
          <p className="text-3xl font-bold text-white">{openOrderCount ?? "—"}</p>
        </Card>

        {/* Active Triggers */}
        <Card>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Active Triggers</h2>
          <p className="text-3xl font-bold text-white">{activeTriggerCount ?? "—"}</p>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Risk Status */}
        <Card>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Risk Status</h2>
          {tradingAllowed ? (
            <Badge color="green">Trading Allowed</Badge>
          ) : (
            <div className="space-y-1">
              {breakers.map((b) => (
                <div key={b.breaker_key} className="flex items-center gap-2">
                  <Badge color="red">{b.breaker_key}</Badge>
                  {b.reason && <span className="text-xs text-gray-400">{b.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* User Quotas */}
        <Card>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Quotas</h2>
          {userStatus ? (
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-white">{userStatus.quotas.maxOrdersPerMin}</p>
                <p className="text-xs text-gray-400">orders/min</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{userStatus.quotas.maxOpenOrders}</p>
                <p className="text-xs text-gray-400">open orders</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{userStatus.quotas.maxDailyOrders}</p>
                <p className="text-xs text-gray-400">daily orders</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Unavailable</p>
          )}
        </Card>
      </div>

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
