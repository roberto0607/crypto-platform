import type { Candle, EqualLevel } from "./types.js";

// ── PDH / PDL ────────────────────────────────────────────────

export function pdh(dailyCandle: Candle): number {
  return dailyCandle.high;
}

export function pdl(dailyCandle: Candle): number {
  return dailyCandle.low;
}

// ── Session High / Low ───────────────────────────────────────

export function sessionHigh(sessionCandles: Candle[]): number {
  let high = -Infinity;
  for (const c of sessionCandles) {
    if (c.high > high) high = c.high;
  }
  return high;
}

export function sessionLow(sessionCandles: Candle[]): number {
  let low = Infinity;
  for (const c of sessionCandles) {
    if (c.low < low) low = c.low;
  }
  return low;
}

// ── Equal Highs (EQH) ───────────────────────────────────────

export function findEqualHighs(
  candles: Candle[],
  atr14_15m: number,
  eqTolerance: number = 0.10,
): EqualLevel | null {
  if (atr14_15m <= 0) return null;

  const window = candles.slice(-20);
  const len = window.length;
  if (len < 5) return null;

  let best: EqualLevel | null = null;

  for (let i = 0; i < len; i++) {
    for (let j = i + 1; j < len; j++) {
      if (j - i < 4) continue;

      const relDiff = Math.abs(window[i].high - window[j].high) / atr14_15m;
      if (relDiff > eqTolerance) continue;

      const candidate: EqualLevel = {
        level: (window[i].high + window[j].high) / 2,
        indexA: i,
        indexB: j,
        relDiff,
      };

      if (best === null) {
        best = candidate;
        continue;
      }

      if (candidate.relDiff < best.relDiff - 0.001) {
        best = candidate;
      } else if (
        Math.abs(candidate.relDiff - best.relDiff) <= 0.001 &&
        Math.max(candidate.indexA, candidate.indexB) >
          Math.max(best.indexA, best.indexB)
      ) {
        best = candidate;
      }
    }
  }

  return best;
}

// ── Equal Lows (EQL) ────────────────────────────────────────

export function findEqualLows(
  candles: Candle[],
  atr14_15m: number,
  eqTolerance: number = 0.10,
): EqualLevel | null {
  if (atr14_15m <= 0) return null;

  const window = candles.slice(-20);
  const len = window.length;
  if (len < 5) return null;

  let best: EqualLevel | null = null;

  for (let i = 0; i < len; i++) {
    for (let j = i + 1; j < len; j++) {
      if (j - i < 4) continue;

      const relDiff = Math.abs(window[i].low - window[j].low) / atr14_15m;
      if (relDiff > eqTolerance) continue;

      const candidate: EqualLevel = {
        level: (window[i].low + window[j].low) / 2,
        indexA: i,
        indexB: j,
        relDiff,
      };

      if (best === null) {
        best = candidate;
        continue;
      }

      if (candidate.relDiff < best.relDiff - 0.001) {
        best = candidate;
      } else if (
        Math.abs(candidate.relDiff - best.relDiff) <= 0.001 &&
        Math.max(candidate.indexA, candidate.indexB) >
          Math.max(best.indexA, best.indexB)
      ) {
        best = candidate;
      }
    }
  }

  return best;
}
