import { useActiveMatchStore, type TradeMode } from "@/stores/activeMatchStore";
import { useAuthStore } from "@/stores/authStore";

const MODES: TradeMode[] = ["MATCH", "PRACTICE"];

/** During a live match: trade the match, or practice on free-play. The only thing that changes it. */
export function MatchScopeSwitch() {
  const live = useActiveMatchStore((s) => s.isInCompetition);
  const tradeMode = useActiveMatchStore((s) => s.tradeMode);
  const setTradeMode = useActiveMatchStore((s) => s.setTradeMode);
  if (!live) return null;

  return (
    <div className="mt-scope" role="radiogroup" aria-label="Trade the match or practice">
      {MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={tradeMode === mode}
          className={`mt-scope-btn${tradeMode === mode ? " active" : ""}`}
          onClick={() => setTradeMode(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

/** Under the header in PRACTICE, so a practice order is never mistaken for a match one. */
export function PracticeBanner() {
  const userId = useAuthStore((s) => s.user?.id);
  const match = useActiveMatchStore((s) => (s.isInCompetition ? s.activeMatch : null));
  const tradeMode = useActiveMatchStore((s) => s.tradeMode);
  const setTradeMode = useActiveMatchStore((s) => s.setTradeMode);
  if (!match || tradeMode !== "PRACTICE") return null;

  const opponent = (match.challenger_id === userId ? match.opponent_name : match.challenger_name) ?? "your opponent";
  return (
    <div className="mt-practice" role="status">
      <span>Live match vs {opponent}</span>
      <button type="button" onClick={() => setTradeMode("MATCH")}>— switch back</button>
    </div>
  );
}
