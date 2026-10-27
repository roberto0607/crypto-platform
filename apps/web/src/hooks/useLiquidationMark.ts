import { useEffect, useState } from "react";
import { useMarkPriceStore } from "@/stores/markPriceStore";
import { positionMark, type PositionMark } from "@/lib/leverageUi";

/**
 * The ISOLATED position card's mark for a pair (lib/leverageUi positionMark).
 * While `active`, re-evaluates every second so a feed that goes silent shows
 * as stale even with no new events.
 */
export function useLiquidationMark(pairId: string, ticker: number, active: boolean): PositionMark {
  const entry = useMarkPriceStore((s) => s.marks[pairId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return positionMark(entry, Math.max(now, entry?.receivedAt ?? 0), ticker);
}
