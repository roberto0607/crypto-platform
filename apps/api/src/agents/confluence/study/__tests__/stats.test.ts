import { describe, it, expect } from "vitest";
import { ranks, spearman, mulberry32, blockBootstrapP, benjaminiHochberg, tercileCuts, tercileOf } from "../stats";

describe("ranks / spearman", () => {
  it("averages tied ranks", () => {
    expect(ranks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
  });

  it("is 1 for any increasing map, −1 for decreasing, NaN without variance", () => {
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [9, 4, 1, 0])).toBeCloseTo(-1, 12);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNaN();
  });

  it("matches a hand-computed value with ties", () => {
    // ranks x: 1, 2.5, 2.5, 4; y: 2, 1, 4, 3 → Pearson of the ranks
    expect(spearman([1, 2, 2, 3], [20, 10, 40, 30])).toBeCloseTo(0.31622776601683794, 12);
  });
});

describe("mulberry32", () => {
  it("is deterministic per seed and in [0, 1)", () => {
    const a = mulberry32(20261116);
    const b = mulberry32(20261116);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

describe("blockBootstrapP", () => {
  const n = 600;
  const rng = mulberry32(1);
  const noise = Array.from({ length: n }, () => rng() - 0.5);
  const x = Array.from({ length: n }, (_, i) => Math.sin(i / 7) + noise[i]!);

  it("is small for a strong relation and the minimum is 2/(B+1)", () => {
    const y = x.map((v, i) => v + 0.2 * noise[(i * 7) % n]!);
    const p = blockBootstrapP(x, y, 6, 2000, 20261116);
    expect(p).toBeCloseTo(2 / 2001, 12);
  });

  it("is large for an unrelated series", () => {
    const r2 = mulberry32(99);
    const y = Array.from({ length: n }, () => r2());
    expect(blockBootstrapP(x, y, 6, 2000, 20261116)).toBeGreaterThan(0.2);
  });

  it("equals ranking each resampled array (the naive way), ties included", () => {
    const naive = (xs: number[], ys: number[], block: number, B: number, seed: number) => {
      const g = mulberry32(seed);
      let lo = 0;
      let hi = 0;
      for (let r = 0; r < B; r++) {
        const bx: number[] = [];
        const by: number[] = [];
        while (bx.length < xs.length) {
          const st = Math.floor(g() * (xs.length - block + 1));
          for (let j = 0; j < block && bx.length < xs.length; j++) {
            bx.push(xs[st + j]!);
            by.push(ys[st + j]!);
          }
        }
        const ic = spearman(bx, by);
        if (Number.isNaN(ic)) continue;
        if (ic <= 0) lo++;
        if (ic >= 0) hi++;
      }
      return Math.min(1, (2 * (1 + Math.min(lo, hi))) / (B + 1));
    };
    const r3 = mulberry32(5);
    const xs = Array.from({ length: 97 }, () => Math.round(r3() * 10)); // many ties
    const ys = xs.map((v) => (r3() < 0.6 ? v : Math.round(r3() * 10)));
    for (const [block, B, seed] of [[1, 300, 1], [6, 300, 2], [18, 200, 3]] as const) {
      expect(blockBootstrapP(xs, ys, block, B, seed)).toBe(naive(xs, ys, block, B, seed));
    }
  });

  it("is reproducible for a seed", () => {
    const y = x.map((v, i) => v * 0.1 + noise[(i * 13) % n]!);
    expect(blockBootstrapP(x, y, 18, 500, 7)).toBe(blockBootstrapP(x, y, 18, 500, 7));
  });
});

describe("benjaminiHochberg", () => {
  it("gives step-up adjusted p-values in the input order", () => {
    // sorted: 0.01, 0.02, 0.03, 0.5 ; m = 4 → 0.04, 0.04, 0.04, 0.5
    expect(benjaminiHochberg([0.03, 0.5, 0.01, 0.02])).toEqual([0.04, 0.5, 0.04, 0.04]);
  });

  it("caps at 1", () => {
    expect(benjaminiHochberg([0.9, 0.8])).toEqual([0.9, 0.9]);
  });
});

describe("terciles", () => {
  it("cuts at the 1/3 and 2/3 quantiles and assigns 0 / 1 / 2", () => {
    const xs = Array.from({ length: 9 }, (_, i) => i + 1); // 1..9
    const cuts = tercileCuts(xs);
    expect(cuts[0]).toBeCloseTo(11 / 3, 12);
    expect(cuts[1]).toBeCloseTo(19 / 3, 12);
    expect(xs.map((v) => tercileOf(v, cuts))).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });
});
