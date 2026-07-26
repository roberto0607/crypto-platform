import { useCompetitionStore } from "@/stores/competitionStore";
import { getTierForElo, isTWTier } from "@/lib/tiers";

/**
 * Compact rank/tier badge + progress-to-next-tier bar for the trade
 * toolbar. Self-subscribes to competitionStore (populated by
 * fetchUserTier() on app init) so callers just render <TierBadge /> with
 * no prop plumbing -- same pattern AlertPanel already uses in
 * TradeToolbar.tsx.
 */
export function TierBadge() {
  const userTier = useCompetitionStore((s) => s.userTier);
  const eloRating = useCompetitionStore((s) => s.eloRating);
  // user_tiers.tier is also written by the unrelated weekly-competition
  // tier system, which uses a different vocabulary (TRADER/SPECIALIST/...)
  // -- guard the same way eloService.ts does server-side so a value from
  // that system never renders as (or is styled as) a bogus TW tier.
  const tier = isTWTier(userTier) ? userTier : "ROOKIE";
  const { progress, nextTier, pointsToNext } = getTierForElo(eloRating);

  const title = nextTier
    ? `${eloRating} ELO — ${pointsToNext} to ${nextTier}`
    : `${eloRating} ELO — LEGEND (max tier)`;

  return (
    <div className="tr-tb-tier" title={title}>
      <span className={`tr-tb-tier-label tr-tb-tier-${tier}`}>{tier}</span>
      <span className="tr-tb-tier-bar-track">
        <span
          className={`tr-tb-tier-bar-fill tr-tb-tier-fill-${tier}`}
          style={{ width: `${progress}%` }}
        />
      </span>
    </div>
  );
}
