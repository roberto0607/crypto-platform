import { describe, it, expect } from "vitest";
import { nextStreak, settleOutcome, MAX_FEED_AGE_MS, STREAK_CAP } from "../quickCallService";

const T = 1_000_000;
const fresh = (price: string) => ({ price, receivedAt: T - 100 });

describe("settleOutcome", () => {
  it("UP wins when exit > entry, loses when exit < entry", () => {
    expect(settleOutcome("UP", "100.00", fresh("100.01"), T)).toBe("WIN");
    expect(settleOutcome("UP", "100.00", fresh("99.99"), T)).toBe("LOSS");
  });

  it("DOWN wins when exit < entry, loses when exit > entry", () => {
    expect(settleOutcome("DOWN", "100.00", fresh("99.99"), T)).toBe("WIN");
    expect(settleOutcome("DOWN", "100.00", fresh("100.01"), T)).toBe("LOSS");
  });

  it("is a push on an exact tie, including differently-formatted equal prices", () => {
    expect(settleOutcome("UP", "100.00", fresh("100.00"), T)).toBe("PUSH");
    expect(settleOutcome("DOWN", "100.4", fresh("100.40"), T)).toBe("PUSH");
  });

  it("compares exactly, not in floating point", () => {
    expect(settleOutcome("UP", "84220.10000001", fresh("84220.10000002"), T)).toBe("WIN");
  });

  it("is void when the feed is stale by more than 5s at settle time", () => {
    const stale = { price: "200", receivedAt: T - MAX_FEED_AGE_MS - 1 };
    expect(settleOutcome("UP", "100", stale, T)).toBe("VOID");
    const edge = { price: "200", receivedAt: T - MAX_FEED_AGE_MS };
    expect(settleOutcome("UP", "100", edge, T)).toBe("WIN");
  });

  it("is void when there is no exit price at all", () => {
    expect(settleOutcome("UP", "100", null, T)).toBe("VOID");
  });
});

describe("nextStreak", () => {
  it("increments on a win, capped at 5", () => {
    expect(nextStreak(0, "WIN")).toBe(1);
    expect(nextStreak(STREAK_CAP, "WIN")).toBe(STREAK_CAP);
  });

  it("resets on a loss", () => {
    expect(nextStreak(4, "LOSS")).toBe(0);
  });

  it("is unchanged on push and void", () => {
    expect(nextStreak(3, "PUSH")).toBe(3);
    expect(nextStreak(3, "VOID")).toBe(3);
  });
});
