import { useCallback, useEffect, useRef, useState } from "react";
import { getPositions } from "@/api/endpoints/analytics";
import { useOrderScope } from "@/lib/orderScope";
import type { Position } from "@/types/api";

/** The open positions of the scope on screen, current through fills, liquidations and scope changes. */
export function useScopedPositions(): { positions: Position[]; refreshPositions: () => void } {
  const scope = useOrderScope();
  const [positions, setPositions] = useState<Position[]>([]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refreshPositions = useCallback(() => {
    const asked = scopeRef.current;
    getPositions({ scope: asked })
      .then((res) => { if (scopeRef.current === asked) setPositions(res.data.positions); })
      .catch(() => {});
  }, []);

  // Positions aren't pair-scoped, so one load per scope. The old scope's rows
  // go at once: they must never sit beside the new scope's order form.
  useEffect(() => {
    setPositions([]);
    refreshPositions();
  }, [scope, refreshPositions]);

  useEffect(() => {
    window.addEventListener("sse:trade.created", refreshPositions);
    window.addEventListener("sse:position.liquidated", refreshPositions);
    return () => {
      window.removeEventListener("sse:trade.created", refreshPositions);
      window.removeEventListener("sse:position.liquidated", refreshPositions);
    };
  }, [refreshPositions]);

  return { positions, refreshPositions };
}
