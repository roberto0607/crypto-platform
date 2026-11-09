import { describe, it, expect } from "vitest";
import { formatPnlPct, formatMatchPnl, formatPnlUsd, formatPnlPctPair, formatMatchPnlPair } from "@/lib/matchPnl";

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
    ["-0.000001", "100000", "-$0.0010 (-<0.0001%)"],
    ["0.0000002", "100000", "+$0.0002 (+<0.0001%)"],
    ["0.00000000", "100000", "$0.00 (0.00%)"],
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

describe("formatMatchPnl: never a frozen $0.00", () => {
  it("any move off zero shows, at the card's precision", () => {
    for (let i = 1; i <= 500; i++) {
      for (const pct of [i / 10_000_000, -i / 10_000_000]) {
        expect(formatMatchPnl(pct, "100000")).not.toMatch(/^[+-]?\$0\.00 /);
      }
    }
  });
});

describe("formatPnlPctPair: two players' results at one precision", () => {
  it("the prod tie: -$10.26 vs -$9.78 on $50,000 no longer both read -0.02%", () => {
    const [a, b] = formatPnlPctPair("-0.02052", "-0.01956");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]!.length).toBe(b.split(".")[1]!.length);  // same decimals
  });

  it("the end overlay's mix (-0.0084% next to -0.02%): both at four decimals", () => {
    expect(formatPnlPctPair("-0.0084", "-0.02")).toEqual(["-0.0084%", "-0.0200%"]);
  });

  it("two decimals when two are enough", () => {
    expect(formatPnlPctPair("12.5", "-3.25")).toEqual(["+12.50%", "-3.25%"]);
    expect(formatPnlPctPair("1.234", "1.236")).toEqual(["+1.23%", "+1.24%"]);
  });

  it("a real tie stays a tie", () => {
    expect(formatPnlPctPair("-0.02", "-0.02")).toEqual(["-0.02%", "-0.02%"]);
    expect(formatPnlPctPair("0", "0")).toEqual(["0.00%", "0.00%"]);
  });

  it("zero next to a tiny loss", () => {
    expect(formatPnlPctPair("0", "-0.0005")).toEqual(["0.0000%", "-0.0005%"]);
  });

  it("different results never print the same, from -0.03% to 0", () => {
    for (let i = 0; i < 3_000; i += 7) {
      const a = -i / 100_000;
      const b = a - 0.0000123;
      const [x, y] = formatPnlPctPair(a, b);
      expect(x).not.toBe(y);
      expect(x).not.toMatch(/^-0\.0+%$/);
    }
  });
});

describe("formatMatchPnlPair: dollars next to the percent", () => {
  it("the prod tie, with dollars", () => {
    const [a, b] = formatMatchPnlPair("-0.02052", "-0.01956", "50000");
    expect([a, b]).toEqual(["-$10.26 (-0.021%)", "-$9.78 (-0.020%)"]);
  });
  it("no capital: the percents alone", () => {
    expect(formatMatchPnlPair("-0.0084", "-0.02", null)).toEqual(["-0.0084%", "-0.0200%"]);
  });
});
