import { describe, it, expect } from "vitest";
import { pickFeatured, toPublicFeaturedMatch } from "../featuredMatch";

const c = (matchId: string, spectatorCount: number, challengerPct: number | null, opponentPct: number | null) => ({
  matchId,
  spectatorCount,
  challengerPct,
  opponentPct,
});

describe("pickFeatured", () => {
  it("returns null when nothing is live", () => {
    expect(pickFeatured([])).toBeNull();
  });

  it("picks the match with the most spectators", () => {
    expect(pickFeatured([c("a", 2, 0, 10), c("b", 7, 0, 50), c("c", 3, 1, 1)])!.matchId).toBe("b");
  });

  it("breaks spectator ties by the smallest return gap", () => {
    expect(pickFeatured([c("a", 5, 0, 10), c("b", 5, 2.5, 2.4), c("c", 5, -1, 3)])!.matchId).toBe("b");
  });

  it("ranks a match with no live returns after tied matches that have them", () => {
    expect(pickFeatured([c("a", 5, null, null), c("b", 5, 0, 40)])!.matchId).toBe("b");
  });

  it("is stable when everything ties", () => {
    expect(pickFeatured([c("b", 1, null, null), c("a", 1, null, null)])!.matchId).toBe("a");
  });
});

describe("toPublicFeaturedMatch", () => {
  const base = {
    matchId: "m1",
    endsAt: new Date(100_000),
    startingCapital: 50_000,
    challengerHandle: "alpha",
    opponentHandle: null,
    spectatorCount: 3,
    challengerPct: 1.5,
    opponentPct: null,
    series: [],
    lastTrades: [],
  };

  it("derives $ P&L from return % × starting capital, and nulls it when the return is unknown", () => {
    const out = toPublicFeaturedMatch(base, 0);
    expect(out.challenger).toEqual({ handle: "alpha", returnPct: 1.5, pnlUsd: 750 });
    expect(out.opponent).toEqual({ handle: null, returnPct: null, pnlUsd: null });
  });

  it("counts secondsLeft down to zero, never negative", () => {
    expect(toPublicFeaturedMatch(base, 40_500).secondsLeft).toBe(59);
    expect(toPublicFeaturedMatch(base, 200_000).secondsLeft).toBe(0);
  });

  it("drops fields that aren't on the allow-list even if the input carries them", () => {
    const sneaky = {
      ...base,
      lastTrades: [{ player: "challenger" as const, side: "BUY" as const, qty: "1", asset: "BTC", at: 1, orderId: "o-1", email: "x@y.z" }],
      series: [{ t: 1, challengerPct: 1, opponentPct: 2, balance: 99 }],
      email: "leak@example.com",
    };
    const json = JSON.stringify(toPublicFeaturedMatch(sneaky, 0));
    expect(json).not.toMatch(/orderId|email|balance|leak@/);
  });
});
