import { useEffect, useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import { useOrderScope } from "@/lib/orderScope";
import { buyingPower } from "@/lib/buyingPower";
import type { Wallet } from "@/types/api";

/**
 * The wallet set the next order will trade: the scope on screen
 * (lib/orderScope), so the match's own wallets (migration 095) or free-play.
 * Null while the match's wallets are still loading, so AVAILABLE never shows
 * free-play cash for a match order. Loaded for the whole match, so switching
 * to PRACTICE and back doesn't refetch them.
 */
export function useOrderWallets(): Wallet[] | null {
  const wallets = useAppStore((s) => s.wallets);
  const matchWallets = useAppStore((s) => s.matchWallets);
  const loadMatchWallets = useAppStore((s) => s.loadMatchWallets);
  const activeMatchId = useActiveMatchStore((s) =>
    s.isInCompetition && s.activeMatch?.status === "ACTIVE" ? s.activeMatch.id : null,
  );
  const scope = useOrderScope();

  useEffect(() => {
    if (activeMatchId !== (matchWallets?.matchId ?? null)) void loadMatchWallets(activeMatchId);
  }, [activeMatchId, matchWallets?.matchId, loadMatchWallets]);

  if (scope === "free") return wallets;
  return matchWallets?.matchId === activeMatchId ? matchWallets.wallets : null;
}

/**
 * Live buying power (the order panel's AVAILABLE) in `quoteAssetId`, over the
 * wallet set the next order trades (useOrderWallets), kept current by
 * wallet.updated and marked at live prices. Null when that set is still
 * loading or a shorted asset has no price yet.
 *
 * The selected pair is marked at the trading snapshot (replay-aware, same as
 * the panel's entry price); other pairs at their latest tick.
 */
export function useBuyingPower(quoteAssetId: string): number | null {
  const wallets = useOrderWallets();
  const pairs = useAppStore((s) => s.pairs);
  const prices = usePairPricesStore((s) => s.prices);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const snapshotLast = useTradingStore((s) => s.snapshot?.last);

  return useMemo(() => {
    if (!wallets) return null;
    const pairByBase = new Map(
      pairs.filter((p) => p.quote_asset_id === quoteAssetId).map((p) => [p.base_asset_id, p.id]),
    );
    return buyingPower(
      quoteAssetId,
      wallets.map((w) => ({ assetId: w.asset_id, balance: w.balance, reserved: w.reserved ?? "0" })),
      (assetId) => {
        const pairId = pairByBase.get(assetId);
        if (!pairId) return null;
        if (pairId === selectedPairId && snapshotLast) return parseFloat(snapshotLast);
        return prices[pairId] ?? null;
      },
    );
  }, [quoteAssetId, wallets, pairs, prices, selectedPairId, snapshotLast]);
}
