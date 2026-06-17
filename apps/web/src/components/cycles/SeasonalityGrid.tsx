import { useState, useEffect } from "react";
import { BTC_MONTHLY_CLOSE } from "@/lib/btcCycles";

// ── Month-seasonality returns heatmap ──
// Year × month grid of close-to-close % returns, derived ENTIRELY from the
// locked BTC_MONTHLY_CLOSE series — no new dataset, no live input, no forecast.
// The MED row is the median per calendar month: descriptive of past seasonality.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// close-to-close monthly % return, keyed "YYYY-MM"
const RET = new Map<string, number>();
for (let i = 1; i < BTC_MONTHLY_CLOSE.length; i++) {
  const [, pv] = BTC_MONTHLY_CLOSE[i - 1]!;
  const [cm, cv] = BTC_MONTHLY_CLOSE[i]!;
  RET.set(cm, ((cv - pv) / pv) * 100);
}
const YEARS = [...new Set([...RET.keys()].map((k) => k.slice(0, 4)))].sort();

function cellPct(year: string, monthIdx: number): number | undefined {
  return RET.get(`${year}-${String(monthIdx + 1).padStart(2, "0")}`);
}
function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

// per-month aggregates for the MED row + tooltips
const MONTH_STATS = MONTHS.map((_, m) => {
  const vals = YEARS.map((y) => cellPct(y, m)).filter((v): v is number => v !== undefined);
  const greens = vals.filter((v) => v > 0).length;
  return { med: median(vals), n: vals.length, winRate: vals.length ? Math.round((greens / vals.length) * 100) : 0 };
});

// tint: green positive / red negative, alpha by magnitude (clamped 0.12–0.85; ±40% = full)
function tint(pct: number): string {
  const a = Math.min(0.85, Math.max(0.12, Math.abs(pct) / 40));
  return `rgba(${pct >= 0 ? "0,255,65" : "255,59,59"}, ${a})`;
}

/** "+178" / "-38" — signed integer for titles. */
function signed(pct: number): string {
  const r = Math.round(pct);
  return `${r >= 0 ? "+" : ""}${r}`;
}

export default function SeasonalityGrid() {
  // One-time fade-in on mount (same rAF-gated pattern as CycleDrawdownTable).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className={`transition-opacity duration-500 ${mounted ? "opacity-100" : "opacity-0"}`}>
      <div className="overflow-x-auto border border-tradr-green/[0.18] bg-tradr-bg2/40">
        <table className="w-full table-fixed font-mono border-collapse">
          <thead>
            <tr className="text-[9px] tracking-[1px] text-white/30 uppercase">
              <th className="px-2 py-1.5 text-left font-normal w-[44px]" />
              {MONTHS.map((m) => (
                <th key={m} className="px-1 py-1.5 text-center font-normal">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {YEARS.map((y) => (
              <tr key={y}>
                <td className="px-2 py-1 text-[9px] text-white/50 border border-tradr-green/[0.06]">{y}</td>
                {MONTHS.map((m, idx) => {
                  const pct = cellPct(y, idx);
                  if (pct === undefined) {
                    return (
                      <td
                        key={m}
                        className="border border-tradr-green/[0.06] bg-tradr-green/[0.02]"
                      />
                    );
                  }
                  return (
                    <td
                      key={m}
                      title={`${MONTHS[idx]} ${y}: ${signed(pct)}%`}
                      style={{ backgroundColor: tint(pct) }}
                      className="px-1 py-1 text-[9px] text-center text-white/85 border border-tradr-green/[0.06] hover:border-tradr-green/40"
                    >
                      {Math.round(pct)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-tradr-green/30">
              <td className="px-2 py-1 text-[9px] font-bold text-tradr-green border border-tradr-green/[0.06]">MED</td>
              {MONTH_STATS.map((s, idx) => {
                if (s.med === undefined) {
                  return <td key={idx} className="border border-tradr-green/[0.06] bg-tradr-green/[0.02]" />;
                }
                return (
                  <td
                    key={idx}
                    title={`${MONTHS[idx]} median ${signed(s.med)}% · ${s.winRate}% green · n=${s.n}`}
                    style={{ backgroundColor: tint(s.med) }}
                    className="px-1 py-1 text-[9px] text-center font-bold text-white/85 border border-tradr-green/[0.06] hover:border-tradr-green/40"
                  >
                    {Math.round(s.med)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="mt-2 text-[9px] text-white/25 tracking-[1px] leading-4 max-w-3xl">
        Monthly close-to-close % returns. Color = direction &amp; magnitude. 2010 &amp; 2026 are partial years.
        MED = median across all available years — descriptive of past seasonality, not a forecast.
      </div>
    </div>
  );
}
