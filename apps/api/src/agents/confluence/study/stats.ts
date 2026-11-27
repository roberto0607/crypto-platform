/**
 * Statistics for the factor study (pre-registration + addendum point 3):
 * Spearman IC with average ranks for ties, a moving-block bootstrap p-value,
 * Benjamini–Hochberg adjusted p-values, and frozen tercile cut points.
 * Deterministic: the bootstrap uses a seeded generator.
 */

/** Ranks 1..n, ties get the average of their ranks. */
export function ranks(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]!] === xs[idx[i]!]) j++;
    const r = (i + j) / 2 + 1;
    for (let m = i; m <= j; m++) out[idx[m]!] = r;
    i = j + 1;
  }
  return out;
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

/**
 * Two-sided p-value of IC = 0. Resample the (x, y) pairs as moving blocks of
 * `block` consecutive rows (uniform start, with replacement) until n rows,
 * B times; p = min(1, 2 × (1 + resampled ICs on the minority side of 0) ÷ (B + 1)).
 */
export function blockBootstrapP(x: number[], y: number[], block: number, resamples: number, seed: number): number {
  const n = x.length;
  if (n < 2 || block < 1) return 1;
  const b = Math.min(block, n);
  const rng = mulberry32(seed);
  const bx = new Array<number>(n);
  const by = new Array<number>(n);
  let atOrBelow = 0;
  let atOrAbove = 0;
  for (let r = 0; r < resamples; r++) {
    let filled = 0;
    while (filled < n) {
      const start = Math.floor(rng() * (n - b + 1));
      for (let j = 0; j < b && filled < n; j++, filled++) {
        bx[filled] = x[start + j]!;
        by[filled] = y[start + j]!;
      }
    }
    const ic = spearman(bx, by);
    if (Number.isNaN(ic)) continue;
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
