import { useEffect, useRef, useState } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import { formatDecimal } from "@/lib/decimal";
import Badge from "@/components/Badge";

const POLL_INTERVAL_MS = 2_000;

export default function PriceTicker() {
  const snapshot = useTradingStore((s) => s.snapshot);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const refreshSnapshot = useTradingStore((s) => s.refreshSnapshot);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevLastRef = useRef<string | null>(null);

  // Poll snapshot every 2s
  useEffect(() => {
    if (!selectedPairId) return;
    const id = setInterval(() => {
      refreshSnapshot();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedPairId, refreshSnapshot]);

  // Flash on price change
  useEffect(() => {
    if (!snapshot) return;
    const prev = prevLastRef.current;
    if (prev !== null && prev !== snapshot.last) {
      setFlash(snapshot.last > prev ? "up" : "down");
      const timer = setTimeout(() => setFlash(null), 600);
      return () => clearTimeout(timer);
    }
    prevLastRef.current = snapshot.last;
  }, [snapshot]);

  // Update ref without triggering flash cleanup
  useEffect(() => {
    if (snapshot) prevLastRef.current = snapshot.last;
  }, [snapshot]);

  if (!snapshot) {
    return <div className="text-sm text-gray-500">--</div>;
  }

  const flashClass =
    flash === "up"
      ? "text-green-400 transition-colors duration-300"
      : flash === "down"
        ? "text-red-400 transition-colors duration-300"
        : "text-white";

  const sourceBadge: Record<string, { color: "green" | "yellow" | "gray"; label: string }> = {
    live: { color: "green", label: "LIVE" },
    replay: { color: "yellow", label: "REPLAY" },
    fallback: { color: "gray", label: "FALLBACK" },
  };

  const badge = sourceBadge[snapshot.source] ?? sourceBadge.fallback!;

  return (
    <div className="flex items-center gap-4">
      {/* Last price — large */}
      <span className={`text-2xl font-bold font-mono ${flashClass}`}>
        {formatDecimal(snapshot.last, 2)}
      </span>

      {/* Bid / Ask */}
      <div className="flex flex-col text-xs font-mono leading-tight">
        <span className="text-green-400">
          B {snapshot.bid ? formatDecimal(snapshot.bid, 2) : "--"}
        </span>
        <span className="text-red-400">
          A {snapshot.ask ? formatDecimal(snapshot.ask, 2) : "--"}
        </span>
      </div>

      {/* Source badge */}
      <Badge color={badge.color}>{badge.label}</Badge>
    </div>
  );
}
