import { describe, it, expect } from "vitest";
import { eloChangeText, eloReason } from "@/lib/eloReason";

describe("eloChangeText", () => {
  it("a zero change is 0, never -0 or +0", () => {
    expect(eloChangeText({ won: false, lost: true, delta: 0 })).toBe("0");
    expect(eloChangeText({ won: false, lost: true, delta: -0 })).toBe("0");
    expect(eloChangeText({ won: true, lost: false, delta: 0 })).toBe("0");
  });
  it("signed otherwise", () => {
    expect(eloChangeText({ won: true, lost: false, delta: 15 })).toBe("+15");
    expect(eloChangeText({ won: false, lost: true, delta: 3 })).toBe("-3");      // a magnitude
    expect(eloChangeText({ won: false, lost: true, delta: -3 })).toBe("-3");     // or signed
    expect(eloChangeText({ won: false, lost: false, delta: 0 })).toBe("0");      // draw
  });
  it("an unrated winner reads UNRATED", () => {
    expect(eloChangeText({ won: true, lost: false, delta: 0, unrated: true })).toBe("UNRATED");
  });
});

describe("eloReason: why a change was unrated or scaled, in plain words", () => {
  const base = { winner_unrated_reason: null, pair_match_number: 1, winner_qualified: true, loser_qualified: true };

  it("a full-value match needs no reason", () => {
    expect(eloReason(base, "winner")).toBeNull();
    expect(eloReason(base, "loser")).toBeNull();
  });

  it("early forfeit", () => {
    expect(eloReason({ ...base, winner_unrated_reason: "EARLY_FORFEIT" }, "winner")).toBe("Early forfeit");
  });

  it("not enough trading: says who", () => {
    const r = { ...base, winner_unrated_reason: "NOT_QUALIFIED" };
    expect(eloReason({ ...r, loser_qualified: false }, "winner")).toBe("Opponent didn't trade enough");
    expect(eloReason({ ...r, winner_qualified: false }, "winner")).toBe("You didn't trade enough");
    expect(eloReason({ ...r, winner_qualified: false, loser_qualified: false }, "winner")).toBe("Neither player traded enough");
    // A row from before the detail was stored.
    expect(eloReason({ winner_unrated_reason: "NOT_QUALIFIED" }, "winner")).toBe("Not enough trading in the match");
  });

  it("a repeat opponent: 0% from the 3rd match in 24h, for both players", () => {
    const r = { ...base, winner_unrated_reason: "REPEAT_OPPONENT", pair_match_number: 3 };
    expect(eloReason(r, "winner")).toBe("Repeat opponent — 3rd match in 24h");
    expect(eloReason({ ...base, pair_match_number: 4 }, "loser")).toBe("Repeat opponent — 4th match in 24h");
    expect(eloReason({ winner_unrated_reason: "REPEAT_OPPONENT" }, "winner")).toBe("Repeat opponent — 3+ matches in 24h");
  });

  it("50% on the 2nd match, for both players", () => {
    expect(eloReason({ ...base, pair_match_number: 2 }, "winner")).toBe("50% — 2nd match vs this opponent today");
    expect(eloReason({ ...base, pair_match_number: 2 }, "loser")).toBe("50% — 2nd match vs this opponent today");
  });

  it("the loser of an unrated win (early forfeit / not enough trading) takes the full loss: no reason", () => {
    expect(eloReason({ ...base, winner_unrated_reason: "EARLY_FORFEIT" }, "loser")).toBeNull();
    expect(eloReason({ ...base, winner_unrated_reason: "NOT_QUALIFIED", loser_qualified: false }, "loser")).toBeNull();
  });

  it("nothing stored (flag off, old rows): nothing to say", () => {
    expect(eloReason({}, "winner")).toBeNull();
    expect(eloReason(null, "loser")).toBeNull();
  });
});
