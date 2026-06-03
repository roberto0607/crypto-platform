import { usePairPricesStore } from "@/stores/pairPricesStore";
import { formatDecimal } from "@/lib/decimal";

/**
 * The single price <td> in the admin pairs table.
 *
 * Extracted (rather than the whole row) because the read must come from a
 * hook — usePairPricesStore — and calling a hook inside the parent's
 * pairs.map() would violate the Rules of Hooks. Only the price cell needs
 * the scoped subscription; the row's controlled input + per-row loading state
 * (priceMap / priceLoading / tradingLoading) stay in the parent where they're
 * cohesive, so this stays a minimal one-prop extraction (see step 6 notes).
 *
 * Renders a single <td> — valid only as a direct child of the parent's <tr>.
 *
 * NOTE: the per-row re-render win is gated on removal of the dual-write
 * scaffold at step 9 (useSSE.ts still calls setPairs per tick, lib/pairs.ts
 * seeds-without-stripping), so the whole admin table still re-renders per tick
 * until then. See useSSE.ts:onPriceTick and lib/pairs.ts.
 */
export default function AdminAssetsPriceCell({ pairId }: { pairId: string }) {
  const price = usePairPricesStore((s) => s.prices[pairId]);
  // 2dp matches the user-facing convention. If precision debugging is needed
  // for admin, change to formatDecimal(String(price), 8) or String(price).
  return (
    <td className="py-2 pr-3">
      {price !== undefined ? formatDecimal(String(price), 2) : "—"}
    </td>
  );
}
