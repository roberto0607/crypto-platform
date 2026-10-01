import type { FeaturedMatch } from "@/api/endpoints/landing";

const W = 400;
const H = 160;
const PAD = 8;
/** A fill just before the first P&L point (which it usually triggered) still gets a marker, pinned to the left edge. */
const EARLY_TRADE_TOLERANCE_MS = 10_000;

interface Props {
  series: FeaturedMatch["series"];
  trades: FeaturedMatch["lastTrades"];
  challengerName: string;
  opponentName: string;
}

/** Two return-% lines racing from a 0% baseline, with trade markers. Renders nothing under 2 points. */
export default function RaceChart({ series, trades, challengerName, opponentName }: Props) {
  if (series.length < 2) return null;

  const t0 = series[0]!.t;
  const t1 = series[series.length - 1]!.t;
  const values = series.flatMap((p) => [p.challengerPct, p.opponentPct]).concat(0);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;

  const x = (t: number) => PAD + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const path = (key: "challengerPct" | "opponentPct") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");

  const valueAt = (t: number, key: "challengerPct" | "opponentPct") => {
    let best = series[0]!;
    for (const p of series) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best[key];
  };

  const markers = trades
    .filter((tr) => tr.at >= t0 - EARLY_TRADE_TOLERANCE_MS && tr.at <= t1)
    .map((tr) => ({ ...tr, at: Math.max(tr.at, t0) }));
  const last = series[series.length - 1]!;
  const summary = `Return race: ${challengerName} ${last.challengerPct.toFixed(2)}%, ${opponentName} ${last.opponentPct.toFixed(2)}%`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={summary}>
      <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.25)" strokeDasharray="2 4" />
      <path d={path("challengerPct")} fill="none" stroke="#7CFF5B" strokeWidth="2" data-testid="line-challenger" />
      <path d={path("opponentPct")} fill="none" stroke="#F2B84B" strokeWidth="2" strokeDasharray="6 4" data-testid="line-opponent" />
      {markers.map((tr, i) => {
        const key = tr.player === "challenger" ? "challengerPct" : "opponentPct";
        const cx = x(tr.at);
        const cy = y(valueAt(tr.at, key));
        const color = tr.player === "challenger" ? "#7CFF5B" : "#F2B84B";
        const d = tr.side === "BUY"
          ? `M${cx},${cy - 9} l5,8 h-10 z`
          : `M${cx},${cy + 9} l5,-8 h-10 z`;
        return <path key={i} d={d} fill={color} data-testid="trade-marker" />;
      })}
    </svg>
  );
}
