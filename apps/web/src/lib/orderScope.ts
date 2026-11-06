import { useActiveMatchStore } from "@/stores/activeMatchStore";

type ScopeState = Pick<ReturnType<typeof useActiveMatchStore.getState>, "activeMatch" | "isInCompetition" | "tradeMode">;

const scopeOf = ({ activeMatch, isInCompetition, tradeMode }: ScopeState): string =>
  isInCompetition && activeMatch?.status === "ACTIVE" && tradeMode === "MATCH" ? activeMatch.id : "free";

/**
 * Which book the trade page shows and trades: the live match's id, or "free"
 * (no match, or PRACTICE during one). Every order, position, open-order,
 * trigger and wallet request names it, so the server never has to infer it,
 * and a free-play order can't land in a match or the other way round.
 */
export function orderScope(): string {
  return scopeOf(useActiveMatchStore.getState());
}

export function useOrderScope(): string {
  return useActiveMatchStore(scopeOf);
}
