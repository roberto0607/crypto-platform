import { useActiveMatchStore } from "@/stores/activeMatchStore";

/**
 * Which book the trade page's open orders and triggers come from: the live
 * match's id, or "free". The request names it (`?scope=`), so a free-play
 * order or TP can't show up during a match, or the other way round.
 */
export function orderScope(): string {
  const { activeMatch, isInCompetition } = useActiveMatchStore.getState();
  return isInCompetition && activeMatch?.status === "ACTIVE" ? activeMatch.id : "free";
}
