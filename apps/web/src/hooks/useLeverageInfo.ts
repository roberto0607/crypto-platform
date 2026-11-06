import { useEffect, useState } from "react";
import { getLeverageInfo } from "@/api/endpoints/leverage";
import { useOrderScope } from "@/lib/orderScope";
import { useTradingStore } from "@/stores/tradingStore";
import type { LeverageInfo } from "@/types/api";

/** Events after which the model/cap/locked leverage may have changed. */
const REFETCH_ON = ["sse:trade.created", "sse:position.liquidated", "sse:reconnected"];

/**
 * GET /leverage for the pair: the margin model and cap the server will give
 * the user's next order there (the web never decides a cap). Refetched on
 * pair, scope or competition change and after fills / liquidations (an open
 * position locks the leverage; closing it frees it).
 *
 * null while loading or if the request fails: the panel then behaves as it
 * did before leverage (SPOT, no selector), never offering more than 1x.
 */
export function useLeverageInfo(pairId: string | null): LeverageInfo | null {
  const [info, setInfo] = useState<LeverageInfo | null>(null);
  const scope = useOrderScope();
  const competitionId = useTradingStore((s) => s.activeCompetitionId);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    for (const e of REFETCH_ON) window.addEventListener(e, bump);
    return () => { for (const e of REFETCH_ON) window.removeEventListener(e, bump); };
  }, []);

  useEffect(() => {
    if (!pairId) {
      setInfo(null);
      return;
    }
    let live = true;
    getLeverageInfo(pairId, scope)
      .then((res) => { if (live) setInfo(res.data.pairId === pairId ? res.data : null); })
      .catch(() => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [pairId, scope, competitionId, nonce]);

  // A response for another pair never applies.
  return info && info.pairId === pairId ? info : null;
}
