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
 * dollars are the percent of the match's starting capital. Under half a cent
 * both read as zero, so the two can't disagree. No capital: the percent alone.
 */
export function formatMatchPnl(pct: string | number | null | undefined, startingCapital: string | number | null | undefined): string {
  const capital = toNumber(startingCapital);
  if (!(capital > 0)) return formatPnlPct(pct);
  const n = toNumber(pct);
  const usd = (capital * n) / 100;
  const abs = Math.abs(usd);
  if (abs < 0.005) return "$0.00 (0.00%)";
  const amount = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${usd < 0 ? "-" : "+"}$${amount} (${formatPnlPct(n)})`;
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
