import { describe, it, expect } from "vitest";
import { detectEMACrosses, type Point } from "@/lib/indicators";

const pts = (start: number, values: number[]): Point[] =>
  values.map((value, i) => ({ time: start + i, value }));

describe("detectEMACrosses", () => {
  it("returns a golden cross on a clean below->above flip", () => {
    // ema200 flat at 10; ema50 rises through it between t=2 and t=3.
    const ema200 = pts(1, [10, 10, 10, 10]); // diffs: -2, -1, +1, +2
    const ema50 = pts(1, [8, 9, 11, 12]);
    expect(detectEMACrosses(ema50, ema200)).toEqual([{ time: 3, type: "golden" }]);
  });

  it("returns a death cross on a clean above->below flip", () => {
    const ema200 = pts(1, [10, 10, 10, 10]); // diffs: +2, +1, -1, -2
    const ema50 = pts(1, [12, 11, 9, 8]);
    expect(detectEMACrosses(ema50, ema200)).toEqual([{ time: 3, type: "death" }]);
  });

  it("does NOT report a phantom cross when arrays are offset/different-length", () => {
    // The alignment trap. ema50 starts at t=1 (6 points), ema200 starts at t=3
    // (4 points). At the COMMON times 3..6 ema50 (1,2,3,4) is always below
    // ema200 (10) => no cross. Zipping by index would pair ema200[0] with
    // ema50[0]=100 and fabricate a death cross — this asserts we don't.
    const ema50 = pts(1, [100, 100, 1, 2, 3, 4]);
    const ema200 = pts(3, [10, 10, 10, 10]);
    expect(detectEMACrosses(ema50, ema200)).toEqual([]);
  });

  it("returns no cross when ema50 stays above ema200 throughout", () => {
    const ema200 = pts(1, [10, 10, 10, 10]);
    const ema50 = pts(1, [20, 21, 22, 23]);
    expect(detectEMACrosses(ema50, ema200)).toEqual([]);
  });

  it("returns multiple crosses in ascending time order", () => {
    const ema200 = pts(1, [10, 10, 10, 10, 10, 10]);
    // diffs: -2, +2, -1, +3, -2, +4 => golden,death,golden,death,golden
    const ema50 = pts(1, [8, 12, 9, 13, 8, 14]);
    const result = detectEMACrosses(ema50, ema200);
    expect(result).toEqual([
      { time: 2, type: "golden" },
      { time: 3, type: "death" },
      { time: 4, type: "golden" },
      { time: 5, type: "death" },
      { time: 6, type: "golden" },
    ]);
    // ascending by time
    const times = result.map((c) => c.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
