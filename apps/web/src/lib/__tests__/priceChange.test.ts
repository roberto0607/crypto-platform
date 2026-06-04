import { describe, it, expect } from "vitest";
import {
  calculatePriceChange,
  dayDirection,
  getMsUntilNextUTCMidnight,
} from "@/lib/priceChange";

// Pure-function tests: no store imports, no React, no fake timers. The
// `todayUTC` and `now` arguments are injected directly so behavior is
// fully deterministic from inputs alone.

const TODAY = "2026-06-03";

describe("calculatePriceChange", () => {
  it("returns null when currentPrice is undefined", () => {
    expect(
      calculatePriceChange(undefined, { open: 100, dateUTC: TODAY }, TODAY),
    ).toBeNull();
  });

  it("returns null when dailyOpen is undefined", () => {
    expect(calculatePriceChange(125, undefined, TODAY)).toBeNull();
  });

  it("returns null when dailyOpen.dateUTC is stale (!= todayUTC)", () => {
    expect(
      calculatePriceChange(125, { open: 100, dateUTC: "2026-06-02" }, TODAY),
    ).toBeNull();
  });

  it("returns null when dailyOpen.open is 0 (avoid divide-by-zero)", () => {
    expect(
      calculatePriceChange(125, { open: 0, dateUTC: TODAY }, TODAY),
    ).toBeNull();
  });

  it("returns a positive fraction when current > open", () => {
    expect(
      calculatePriceChange(125, { open: 100, dateUTC: TODAY }, TODAY),
    ).toBe(0.25);
  });

  it("returns a negative fraction when current < open", () => {
    expect(
      calculatePriceChange(75, { open: 100, dateUTC: TODAY }, TODAY),
    ).toBe(-0.25);
  });

  it("returns 0 when current === open", () => {
    expect(
      calculatePriceChange(100, { open: 100, dateUTC: TODAY }, TODAY),
    ).toBe(0);
  });
});

describe("dayDirection", () => {
  it("maps null to flat (open not cached → neutral white, no false color)", () => {
    expect(dayDirection(null)).toBe("flat");
  });

  it("maps a positive change to up", () => {
    expect(dayDirection(0.04)).toBe("up");
  });

  it("maps a negative change to down", () => {
    expect(dayDirection(-0.0421)).toBe("down");
  });

  it("maps exactly 0 to flat", () => {
    expect(dayDirection(0)).toBe("flat");
  });
});

describe("getMsUntilNextUTCMidnight", () => {
  it("returns a full 24h when called at exact UTC midnight", () => {
    expect(
      getMsUntilNextUTCMidnight(new Date("2026-06-03T00:00:00.000Z")),
    ).toBe(86_400_000);
  });

  it("returns 1ms when called 1ms before UTC midnight", () => {
    expect(
      getMsUntilNextUTCMidnight(new Date("2026-06-03T23:59:59.999Z")),
    ).toBe(1);
  });

  it("returns 12h when called at noon UTC", () => {
    expect(
      getMsUntilNextUTCMidnight(new Date("2026-06-03T12:00:00.000Z")),
    ).toBe(43_200_000);
  });
});
