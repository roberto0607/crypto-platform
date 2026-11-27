/**
 * Statistics for the factor study (pre-registration + addendum point 3):
 * Spearman IC with average ranks for ties, a moving-block bootstrap p-value,
 * Benjamini–Hochberg adjusted p-values, and frozen tercile cut points.
 * Deterministic: the bootstrap uses a seeded generator.
 */

/**
 * Ranks 1..n, ties get the average of their ranks. Sorts a typed copy
 * (native numeric sort) and finds each value's tie run by binary search:
 * the bootstrap calls this hundreds of thousands of times.
 */
export function ranks(xs: number[]): number[] {
  const sorted = Float64Array.from(xs).sort();
  const lowerBound = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upperBound = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return xs.map((v) => (lowerBound(v) + upperBound(v) - 1) / 2 + 1);
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function spearman(x: number[], y: number[]): number {
  return pearson(ranks(x), ranks(y));
}

/** Small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Original indices sorted by value, cut into runs of equal values. */
function tieGroups(xs: number[]): { order: Int32Array; groupEnd: Int32Array } {
  const order = Int32Array.from(xs.map((_, i) => i)).sort((a, b) => xs[a]! - xs[b]!);
  const groupEnd = new Int32Array(order.length);
  for (let i = order.length - 1; i >= 0; i--) {
    groupEnd[i] = i + 1 < order.length && xs[order[i + 1]!] === xs[order[i]!] ? groupEnd[i + 1]! : i + 1;
  }
  return { order, groupEnd };
}

/** Average ranks of a resample given how many times each original row was drawn. */
function rankFromCounts(g: { order: Int32Array; groupEnd: Int32Array }, counts: Int32Array, out: Float64Array): void {
  let cum = 0;
  for (let i = 0; i < g.order.length; ) {
    const end = g.groupEnd[i]!;
    let c = 0;
    for (let j = i; j < end; j++) c += counts[g.order[j]!]!;
    const r = cum + (c + 1) / 2;
    for (let j = i; j < end; j++) out[g.order[j]!] = r;
    cum += c;
    i = end;
  }
}

/**
 * Two-sided p-value of IC = 0. Resample the (x, y) pairs as moving blocks of
 * `block` consecutive rows (uniform start, with replacement) until n rows,
 * B times; p = min(1, 2 × (1 + resampled ICs on the minority side of 0) ÷ (B + 1)).
 *
 * A resample only repeats original rows, so its Spearman IC is computed
 * exactly from draw counts: average ranks from a sort done once, then a
 * count-weighted Pearson. The same number as ranking the resampled arrays,
 * in O(n) per resample.
 */
export function blockBootstrapP(x: number[], y: number[], block: number, resamples: number, seed: number): number {
  const n = x.length;
  if (n < 2 || block < 1) return 1;
  const b = Math.min(block, n);
  const rng = mulberry32(seed);
  const gx = tieGroups(x);
  const gy = tieGroups(y);
  const counts = new Int32Array(n);
  const rx = new Float64Array(n);
  const ry = new Float64Array(n);
  let atOrBelow = 0;
  let atOrAbove = 0;
  for (let r = 0; r < resamples; r++) {
    counts.fill(0);
    let filled = 0;
    while (filled < n) {
      const start = Math.floor(rng() * (n - b + 1));
      for (let j = 0; j < b && filled < n; j++, filled++) counts[start + j]!++;
    }
    rankFromCounts(gx, counts, rx);
    rankFromCounts(gy, counts, ry);
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += counts[i]! * rx[i]!;
      my += counts[i]! * ry[i]!;
    }
    mx /= n;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const c = counts[i]!;
      if (c === 0) continue;
      const dx = rx[i]! - mx;
      const dy = ry[i]! - my;
      sxy += c * dx * dy;
      sxx += c * dx * dx;
      syy += c * dy * dy;
    }
    if (!(sxx > 0 && syy > 0)) continue;
    const ic = sxy / Math.sqrt(sxx * syy);
    if (ic <= 0) atOrBelow++;
    if (ic >= 0) atOrAbove++;
  }
  return Math.min(1, (2 * (1 + Math.min(atOrBelow, atOrAbove))) / (resamples + 1));
}

/** Benjamini–Hochberg step-up adjusted p-values, in the input order. */
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((_, i) => i).sort((a, b) => ps[a]! - ps[b]!);
  const adj = new Array<number>(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    const i = order[k]!;
    running = Math.min(running, (ps[i]! * m) / (k + 1));
    adj[i] = Math.min(1, running);
  }
  return adj;
}

/** Linear-interpolation quantile (type 7) of sorted values. */
function quantile(sorted: number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/** The 1/3 and 2/3 quantiles: the cut points, frozen once computed. */
export function tercileCuts(xs: number[]): [number, number] {
  const s = [...xs].sort((a, b) => a - b);
  return [quantile(s, 1 / 3), quantile(s, 2 / 3)];
}

/** 0 = low (≤ first cut), 2 = high (> second cut), 1 = middle. */
export function tercileOf(v: number, cuts: [number, number]): 0 | 1 | 2 {
  if (v <= cuts[0]) return 0;
  if (v > cuts[1]) return 2;
  return 1;
}
