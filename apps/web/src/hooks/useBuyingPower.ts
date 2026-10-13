import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useTradingStore } from "@/stores/tradingStore";
import { buyingPower } from "@/lib/buyingPower";

/**
 * Live buying power (the order panel's AVAILABLE) in `quoteAssetId`, from the
 * user's wallets (kept current by wallet.updated) marked at live prices. Null
 * when a shorted asset has no price yet.
 *
 * The selected pair is marked at the trading snapshot (replay-aware, same as
 * the panel's entry price); other pairs at their latest tick.
 */
export function useBuyingPower(quoteAssetId: string): number | null {
  const wallets = useAppStore((s) => s.wallets);
  const pairs = useAppStore((s) => s.pairs);
  const prices = usePairPricesStore((s) => s.prices);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const snapshotLast = useTradingStore((s) => s.snapshot?.last);

  return useMemo(() => {
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
