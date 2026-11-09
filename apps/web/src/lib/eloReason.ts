/**
 * Plain words for a 1v1 ELO change under the integrity rules
 * (ELO_INTEGRITY_ENABLED, api competitions/eloIntegrity.ts):
 *   - the winner is UNRATED on an early forfeit, when either player didn't
 *     trade enough, or on the pair's 3rd+ match in 24h;
 *   - both players' changes are 50% on the pair's 2nd match in 24h and 0%
 *     from the 3rd (the loser still loses on an unrated win otherwise).
 */

/** What match_elo_results stores about why (null on rows before it / flag off). */
export interface EloReasonDetail {
  winner_unrated_reason?: string | null;
  pair_match_number?: number | null;
  winner_qualified?: boolean | null;
  loser_qualified?: boolean | null;
}

/** The ELO change as shown: "+15", "-3", "UNRATED", and "0" for no change (never "-0"). */
export function eloChangeText(p: { won: boolean; lost: boolean; delta: number; unrated?: boolean }): string {
  if (p.won && p.unrated) return "UNRATED";
  const size = Math.abs(p.delta);
  if (size === 0 || (!p.won && !p.lost)) return "0";
  return p.won ? `+${size}` : `-${size}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

const repeat = (n: number | null | undefined) =>
  n ? `Repeat opponent — ${ordinal(n)} match in 24h` : "Repeat opponent — 3+ matches in 24h";

/** Why this player's change was unrated or scaled; null when it counted in full. */
export function eloReason(d: EloReasonDetail | null | undefined, as: "winner" | "loser"): string | null {
  if (!d) return null;
  const n = d.pair_match_number ?? null;
  if (as === "winner") {
    switch (d.winner_unrated_reason) {
      case "EARLY_FORFEIT":
        return "Early forfeit";
      case "NOT_QUALIFIED":
        if (d.winner_qualified === false && d.loser_qualified === false) return "Neither player traded enough";
        if (d.winner_qualified === false) return "You didn't trade enough";
        if (d.loser_qualified === false) return "Opponent didn't trade enough";
        return "Not enough trading in the match";
      case "REPEAT_OPPONENT":
        return repeat(n);
    }
  }
  if (n !== null && n >= 3) return repeat(n);
  if (n === 2) return "50% — 2nd match vs this opponent today";
  return null;
}
