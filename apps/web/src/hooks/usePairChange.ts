import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useDailyOpenStore } from "@/stores/dailyOpenStore";
import { calculatePriceChange } from "@/lib/priceChange";
import type { UUID } from "@/types/api";

export function usePairChange(pairId: UUID): number | null {
  const price = usePairPricesStore((s) => s.prices[pairId]);
  const dailyOpen = useDailyOpenStore((s) => s.opens[pairId]);
  const todayUTC = new Date().toISOString().slice(0, 10);
  return calculatePriceChange(price, dailyOpen, todayUTC);
}
