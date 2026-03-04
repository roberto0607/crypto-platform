import { useState, useCallback } from "react";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { getTransactions } from "@/api/endpoints/wallets";
import { formatDecimal } from "@/lib/decimal";
import type { LedgerEntry } from "@/types/api";
import Card from "@/components/Card";
import Spinner from "@/components/Spinner";
import Badge from "@/components/Badge";

const TX_PAGE_SIZE = 20;

export default function WalletsPage() {
  const wallets = useAppStore((s) => s.wallets);
  const assets = useAppStore((s) => s.assets);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  function assetSymbol(assetId: string): string {
    return assets.find((a) => a.id === assetId)?.symbol ?? "???";
  }

  if (wallets.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-white">Wallets</h1>
        <p className="text-sm text-gray-500">No wallets yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-white">Wallets</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {wallets.map((wallet) => {
          const symbol = wallet.symbol ?? assetSymbol(wallet.asset_id);
          const balance = new Decimal(wallet.balance);
          const reserved = new Decimal(wallet.reserved);
          const available = balance.minus(reserved);
          const isExpanded = expandedId === wallet.id;

          return (
            <div key={wallet.id}>
              <Card
                className={`cursor-pointer transition-colors hover:border-gray-700 ${
                  isExpanded ? "border-blue-800" : ""
                }`}
              >
                <div
                  onClick={() => setExpandedId(isExpanded ? null : wallet.id)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-lg font-bold text-white">{symbol}</span>
                    {reserved.gt(0) && <Badge color="yellow">Reserved</Badge>}
                  </div>

                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Balance</span>
                      <span className="font-mono text-gray-200">
                        {formatDecimal(wallet.balance, symbol === "USD" ? 2 : 8)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Reserved</span>
                      <span className="font-mono text-gray-400">
                        {formatDecimal(wallet.reserved, symbol === "USD" ? 2 : 8)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-gray-800 pt-1">
                      <span className="text-gray-400 font-medium">Available</span>
                      <span className="font-mono text-white font-medium">
                        {formatDecimal(available.toString(), symbol === "USD" ? 2 : 8)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Expanded: transactions */}
                {isExpanded && (
                  <div className="mt-3 border-t border-gray-800 pt-3">
                    <TransactionList walletId={wallet.id} symbol={symbol} />
                  </div>
                )}
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TransactionList({ walletId, symbol }: { walletId: string; symbol: string }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const decimals = symbol === "USD" ? 2 : 8;

  const fetchTxns = useCallback(
    async (cursor?: string) => {
      const isMore = !!cursor;
      if (isMore) setLoadingMore(true);
      else setLoading(true);

      try {
        const res = await getTransactions(walletId, {
          cursor: cursor || undefined,
          limit: TX_PAGE_SIZE,
        });
        if (isMore) {
          setEntries((prev) => [...prev, ...res.data.entries]);
        } else {
          setEntries(res.data.entries);
        }
        setNextCursor(res.data.nextCursor);
      } catch {
        // Non-fatal
      }

      if (isMore) setLoadingMore(false);
      else setLoading(false);
      setLoaded(true);
    },
    [walletId],
  );

  // Fetch on first render
  if (!loaded && loading) {
    fetchTxns();
  }

  if (loading && !loaded) {
    return (
      <div className="flex justify-center py-3">
        <Spinner size="sm" />
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="text-xs text-gray-500 text-center py-2">No transactions</p>;
  }

  function entryColor(type: string): string {
    if (type.includes("CREDIT") || type === "RELEASE") return "text-green-400";
    if (type.includes("DEBIT") || type === "RESERVE" || type === "FEE") return "text-red-400";
    return "text-gray-300";
  }

  function entrySign(type: string): string {
    if (type.includes("CREDIT") || type === "RELEASE") return "+";
    if (type.includes("DEBIT") || type === "RESERVE" || type === "FEE") return "-";
    return "";
  }

  return (
    <div className="space-y-0.5 max-h-60 overflow-y-auto">
      {entries.map((entry) => {
        const date = new Date(entry.created_at);
        const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const timeStr = date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

        return (
          <div
            key={entry.id}
            className="flex items-center justify-between py-1 text-xs hover:bg-gray-800/30 rounded px-1"
          >
            <div className="flex items-center gap-2">
              <span className="text-gray-500 w-20">{dateStr} {timeStr}</span>
              <Badge color="gray">{entry.entry_type}</Badge>
            </div>
            <div className="flex items-center gap-3">
              <span className={`font-mono ${entryColor(entry.entry_type)}`}>
                {entrySign(entry.entry_type)}{formatDecimal(entry.amount, decimals)}
              </span>
              <span className="font-mono text-gray-500 w-24 text-right">
                {formatDecimal(entry.balance_after, decimals)}
              </span>
            </div>
          </div>
        );
      })}

      {nextCursor && (
        <div className="text-center pt-1">
          <button
            onClick={() => fetchTxns(nextCursor)}
            disabled={loadingMore}
            className="text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-50"
          >
            {loadingMore ? <Spinner size="sm" /> : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}
