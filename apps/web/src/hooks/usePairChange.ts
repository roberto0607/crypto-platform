import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useDailyOpenStore } from "@/stores/dailyOpenStore";
import { calculatePriceChange, dayDirection } from "@/lib/priceChange";
import type { UUID } from "@/types/api";

export function usePairChange(pairId: UUID): number | null {
  const price = usePairPricesStore((s) => s.prices[pairId]);
  const dailyOpen = useDailyOpenStore((s) => s.opens[pairId]);
  const todayUTC = new Date().toISOString().slice(0, 10);
  return calculatePriceChange(price, dailyOpen, todayUTC);
}

/**
 * dayDirection(usePairChange(pairId)), or null while the change is unknown —
 * but the caller re-renders only when the DIRECTION changes, not on every tick.
 */
export function usePairDayDirection(pairId: UUID): "up" | "down" | "flat" | null {
  const dailyOpen = useDailyOpenStore((s) => s.opens[pairId]);
  return usePairPricesStore((s) => {
    const change = calculatePriceChange(s.prices[pairId], dailyOpen, new Date().toISOString().slice(0, 10));
    return change === null ? null : dayDirection(change);
  });
}
