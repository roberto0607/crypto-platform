/** Below this a percent needs more decimals than two; below TINY, more than four. */
const TWO_DP_FROM = 0.01;
const TINY = 0.00005;
/** The server sends 8 decimals, so anything smaller is zero. */
const ZERO = 0.00000001;
const TINY_USD = 0.00005;

const toNumber = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(v ?? "0");
  return Number.isFinite(n) ? n : 0;
};

/**
 * A signed P&L percent that never reads "-0.00%": two decimals, four under
 * 0.01% (a fee-sized loss is a real number), `<0.0001%` under that. Only a
 * true zero has no sign.
 */
export function formatPnlPct(pct: string | number | null | undefined): string {
  const n = toNumber(pct);
  const abs = Math.abs(n);
  if (abs < ZERO) return "0.00%";
  const sign = n < 0 ? "-" : "+";
  if (abs >= TWO_DP_FROM) return `${sign}${abs.toFixed(2)}%`;
  return abs < TINY ? `${sign}<0.0001%` : `${sign}${abs.toFixed(4)}%`;
}

/**
 * Dollars and percent of a player's match P&L: "-$0.50 (-0.0005%)". The
 * dollars are the percent of the match's starting capital, at the position
 * card's precision (formatPnlUsd), so a move off zero is never a frozen $0.00.
 * No capital: the percent alone.
 */
export function formatMatchPnl(pct: string | number | null | undefined, startingCapital: string | number | null | undefined): string {
  const capital = toNumber(startingCapital);
  if (!(capital > 0)) return formatPnlPct(pct);
  const n = toNumber(pct);
  const usd = (capital * n) / 100;
  if (Math.abs(usd) < ZERO) return "$0.00 (0.00%)";
  return `${formatPnlUsd(usd)} (${formatPnlPct(n)})`;
}

/**
 * A signed dollar P&L that never sits at a frozen "+$0.00": cents from a cent
 * up, four decimals below that, `<$0.0001` under those. Only a true zero has
 * no sign.
 */
export function formatPnlUsd(usd: number): string {
  const abs = Math.abs(usd);
  if (abs < ZERO) return "$0.00";
  const sign = usd < 0 ? "-" : "+";
  if (abs >= 0.01) return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return abs < TINY_USD ? `${sign}<$0.0001` : `${sign}$${abs.toFixed(4)}`;
}

/** The most decimals a pair of results is shown with to tell them apart. */
const MAX_PAIR_DP = 6;

/**
 * Decimals for showing two players' P&L percents side by side: the same for
 * both, so a match never mixes "-0.0084%" with "-0.02%". Two by default,
 * four once either is under 0.01% (as formatPnlPct), then more until two
 * different results stop reading the same (up to six). A real tie stays at
 * the fewest decimals.
 */
export function pnlPctDecimals(values: (string | number | null | undefined)[]): number {
  const nums = values.map(toNumber);
  let dp = nums.some((n) => Math.abs(n) >= ZERO && Math.abs(n) < TWO_DP_FROM) ? 4 : 2;
  const clash = (d: number) => nums.some((a, i) => nums.some((b, j) =>
    j > i && a.toFixed(8) !== b.toFixed(8) && pctAt(a, d) === pctAt(b, d)));
  while (dp < MAX_PAIR_DP && clash(dp)) dp++;
  return dp;
}

/** A signed percent at exactly `dp` decimals; `<0.0…1%` below that, unsigned 0 only for a true zero. */
function pctAt(n: number, dp: number): string {
  const abs = Math.abs(n);
  if (abs < ZERO) return `${(0).toFixed(dp)}%`;
  const sign = n < 0 ? "-" : "+";
  const step = 10 ** -dp;
  if (abs < step / 2) return `${sign}<${step.toFixed(dp)}%`;
  return `${sign}${abs.toFixed(dp)}%`;
}

/** Two players' P&L percents at one precision (pnlPctDecimals). */
export function formatPnlPctPair(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): [string, string] {
  const dp = pnlPctDecimals([a, b]);
  return [pctAt(toNumber(a), dp), pctAt(toNumber(b), dp)];
}

/** formatMatchPnl for both players, the percents at one precision: "-$10.26 (-0.0205%)". */
export function formatMatchPnlPair(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  startingCapital: string | number | null | undefined,
): [string, string] {
  const dp = pnlPctDecimals([a, b]);
  const capital = toNumber(startingCapital);
  const one = (v: string | number | null | undefined) => {
    const n = toNumber(v);
    if (!(capital > 0)) return pctAt(n, dp);
    return `${formatPnlUsd((capital * n) / 100)} (${pctAt(n, dp)})`;
  };
  return [one(a), one(b)];
}
