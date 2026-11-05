import { describe, it, expect } from "vitest";
import { formatPnlPct, formatMatchPnl, formatPnlUsd } from "@/lib/matchPnl";

describe("formatPnlPct", () => {
  it.each([
    ["1.23456", "+1.23%"],
    ["-1.23456", "-1.23%"],
    ["0.01", "+0.01%"],
    ["-0.0100", "-0.01%"],
    ["0.0051", "+0.0051%"],
    ["-0.0005", "-0.0005%"],
    ["-0.00004", "-<0.0001%"],
    ["0.00004", "+<0.0001%"],
    ["0", "0.00%"],
    ["0.00000000", "0.00%"],
    ["-0.00000000", "0.00%"],
  ])("%s -> %s", (input, out) => {
    expect(formatPnlPct(input)).toBe(out);
  });

  it("no value reads as zero; not a number too", () => {
    expect(formatPnlPct(null)).toBe("0.00%");
    expect(formatPnlPct(undefined)).toBe("0.00%");
    expect(formatPnlPct("nope")).toBe("0.00%");
  });

  it("takes numbers", () => {
    expect(formatPnlPct(-0)).toBe("0.00%");
    expect(formatPnlPct(12.5)).toBe("+12.50%");
  });

  it("never prints a negative zero, anywhere from -0.02 to 0", () => {
    for (let i = 0; i <= 20_000; i++) {
      const out = formatPnlPct(-i / 1_000_000);
      expect(out).not.toMatch(/^-0\.0+%$/);
    }
  });
});

describe("formatMatchPnl", () => {
  it.each([
    ["1.23456", "100000", "+$1,234.56 (+1.23%)"],
    ["-5", "100000", "-$5,000.00 (-5.00%)"],
    ["-0.0005", "100000", "-$0.50 (-0.0005%)"],
    ["-0.00002", "100000", "-$0.02 (-<0.0001%)"],
    ["0", "100000", "$0.00 (0.00%)"],
    ["-0.000001", "100000", "$0.00 (0.00%)"],
  ])("%s of %s -> %s", (pct, capital, out) => {
    expect(formatMatchPnl(pct, capital)).toBe(out);
  });

  it("no capital: the percent alone", () => {
    expect(formatMatchPnl("1.5", null)).toBe("+1.50%");
    expect(formatMatchPnl("1.5", "0")).toBe("+1.50%");
  });
});

describe("formatPnlUsd", () => {
  it.each([
    [1234.5, "+$1,234.50"],
    [-67.82, "-$67.82"],
    [1, "+$1.00"],
    [0.42, "+$0.42"],
    [-0.01, "-$0.01"],
    [0.0006, "+$0.0006"],
    [-0.0006, "-$0.0006"],
    [0.0049, "+$0.0049"],
    [0.00004, "+<$0.0001"],
    [-0.00004, "-<$0.0001"],
    [0, "$0.00"],
    [-0, "$0.00"],
    [1e-12, "$0.00"],
  ])("%s -> %s", (input, out) => {
    expect(formatPnlUsd(input)).toBe(out);
  });

  it("never reads as a frozen zero while the position is off zero", () => {
    for (let i = 1; i <= 2_000; i++) {
      for (const n of [i / 1_000_000, -i / 1_000_000]) {
        expect(formatPnlUsd(n)).not.toMatch(/^[+-]\$0\.00$/);
      }
    }
  });
});
