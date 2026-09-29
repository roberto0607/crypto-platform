/**
 * featuredMatch.ts — pick the one live match the landing page shows, and
 * shape it into the public payload.
 *
 * The payload is built field-by-field from an allow-list — never by spreading
 * a DB row — so balances, order ids, user ids, and emails can't leak in when
 * a query or table grows a column.
 */

export interface MatchCandidate {
  matchId: string;
  spectatorCount: number;
  challengerPct: number | null;
  opponentPct: number | null;
}

/**
 * Most spectators wins; ties go to the closer race (smallest return gap).
 * A match with no live returns yet sorts after any match that has them.
 * Final tiebreak on matchId keeps the choice stable between recomputes.
 */
export function pickFeatured<T extends MatchCandidate>(candidates: T[]): T | null {
  const gap = (c: MatchCandidate) =>
    c.challengerPct === null || c.opponentPct === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(c.challengerPct - c.opponentPct);

  const sorted = [...candidates].sort(
    (a, b) =>
      b.spectatorCount - a.spectatorCount ||
      gap(a) - gap(b) ||
      a.matchId.localeCompare(b.matchId),
  );
  return sorted[0] ?? null;
}

export type PlayerRole = "challenger" | "opponent";

export interface PublicPlayer {
  handle: string | null;
  returnPct: number | null;
  pnlUsd: number | null;
}

export interface PublicTrade {
  player: PlayerRole;
  side: "BUY" | "SELL";
  qty: string;
  asset: string;
  at: number;
}

export interface SeriesPoint {
  t: number;
  challengerPct: number;
  opponentPct: number;
}

export interface FeaturedMatch {
  matchId: string;
  secondsLeft: number;
  spectatorCount: number;
  challenger: PublicPlayer;
  opponent: PublicPlayer;
  series: SeriesPoint[];
  lastTrades: PublicTrade[];
}

export interface FeaturedMatchInput {
  matchId: string;
  endsAt: Date;
  startingCapital: number;
  challengerHandle: string | null;
  opponentHandle: string | null;
  spectatorCount: number;
  challengerPct: number | null;
  opponentPct: number | null;
  series: SeriesPoint[];
  lastTrades: PublicTrade[];
}

function player(handle: string | null, pct: number | null, startingCapital: number): PublicPlayer {
  return {
    handle,
    returnPct: pct,
    pnlUsd: pct === null ? null : Math.round(pct * startingCapital) / 100,
  };
}

export function toPublicFeaturedMatch(input: FeaturedMatchInput, now: number): FeaturedMatch {
  return {
    matchId: input.matchId,
    secondsLeft: Math.max(0, Math.floor((input.endsAt.getTime() - now) / 1000)),
    spectatorCount: input.spectatorCount,
    challenger: player(input.challengerHandle, input.challengerPct, input.startingCapital),
    opponent: player(input.opponentHandle, input.opponentPct, input.startingCapital),
    series: input.series.map((p) => ({ t: p.t, challengerPct: p.challengerPct, opponentPct: p.opponentPct })),
    lastTrades: input.lastTrades.map((t) => ({
      player: t.player,
      side: t.side,
      qty: t.qty,
      asset: t.asset,
      at: t.at,
    })),
  };
}
