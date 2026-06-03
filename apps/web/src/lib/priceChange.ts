import type { DailyOpen } from "@/stores/dailyOpenStore";

/**
 * Compute 24h price change as a fraction (e.g. 0.025 = +2.5%).
 * Returns null when the change cannot be computed yet:
 *   - currentPrice unavailable (SSE hasn't ticked yet)
 *   - dailyOpen unavailable (cold-load fetch hasn't completed)
 *   - dailyOpen is stale (cached for a previous UTC day; midnight rollover refetch pending)
 *
 * Pure function — no React, no store reads. Drives the usePairChange hook
 * and is the unit-tested surface for change-derivation logic.
 */
export function calculatePriceChange(
  currentPrice: number | undefined,
  dailyOpen: DailyOpen | undefined,
  todayUTC: string,
): number | null {
  if (currentPrice === undefined || dailyOpen === undefined) return null;
  if (dailyOpen.dateUTC !== todayUTC) return null;
  if (dailyOpen.open === 0) return null; // avoid divide-by-zero
  return (currentPrice - dailyOpen.open) / dailyOpen.open;
}

/** Milliseconds until the next UTC midnight, for setTimeout-based daily-open refresh. */
export function getMsUntilNextUTCMidnight(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0); // setUTCHours(24, ...) rolls to next day at 00:00 UTC
  return next.getTime() - now.getTime();
}
