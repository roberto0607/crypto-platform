import { useState, useEffect } from "react";
import { BTC_CYCLES, BTC_ATH, BTC_HALVINGS } from "@/lib/btcCycles";

// ── Bitcoin cycle drawdown table ──
// Four historical peak→trough cycles + a live "NOW" row anchored to the
// Oct-2025 ATH. The only live input is currentPrice (BTC, from pairPricesStore);
// everything else is the vetted static dataset. Degrades to "—" without a price.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2011-06-08" → "Jun 2011" */
function monthYear(iso: string): string {
  const [y, m] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** Compact comma-grouped USD: 31.91 → "$31.91", 69000 → "$69,000". */
function usd(v: number): string {
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** "851 d (~28 mo)" — months = round(days / 30.4) per spec. */
function underwater(days: number): string {
  return `${days} d (~${Math.round(days / 30.4)} mo)`;
}

// ── REBOUND: bottom → next cycle's top (last cycle's "next top" is the ATH) ──
function nextTopFor(i: number): number {
  return i < BTC_CYCLES.length - 1 ? BTC_CYCLES[i + 1]!.topPrice : BTC_ATH.price;
}
const REBOUND_MULTS = BTC_CYCLES.map((c, i) => nextTopFor(i) / c.bottomPrice);
const MAX_REBOUND_MULT = Math.max(...REBOUND_MULTS);

/** Whole multiple; exact-half ties round down so ×581.5 reads ×581 (matches cited figures). */
function roundMult(x: number): number {
  return Math.ceil(x - 0.5);
}
/**
 * Log-scaled bar width: multiples span ~2 orders of magnitude (×8 … ×581), so a
 * linear bar would make ×8 invisible next to ×581. Normalize log10 against the max.
 */
function reboundBarWidth(mult: number): number {
  return (Math.log10(mult) / Math.log10(MAX_REBOUND_MULT)) * 100;
}

/** Whole months from the latest halving on/before a top date to that top; null if none precedes. */
function halvingToTopMonths(topISO: string): number | null {
  const prior = BTC_HALVINGS.filter((h) => h.date <= topISO);
  if (!prior.length) return null;
  const [hy, hm] = prior[prior.length - 1]!.date.slice(0, 7).split("-");
  const [ty, tm] = topISO.slice(0, 7).split("-");
  return (Number(ty) - Number(hy)) * 12 + (Number(tm) - Number(hm));
}

interface Props {
  currentPrice?: number;
}

export default function CycleDrawdownTable({ currentPrice }: Props) {
  const hasPrice = currentPrice !== undefined && Number.isFinite(currentPrice);
  const liveDrawdown = hasPrice
    ? Math.round(((currentPrice! - BTC_ATH.price) / BTC_ATH.price) * 100)
    : null;
  const daysSinceAth = Math.floor((Date.now() - Date.parse(BTC_ATH.date)) / 86_400_000);

  // Grow the drawdown bars from 0 → target on mount (one rAF after first paint).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="overflow-x-auto border border-tradr-green/[0.18] bg-tradr-bg2/40">
      <table className="w-full font-mono text-[11px] border-collapse">
        <thead>
          <tr className="text-[9px] tracking-[2px] text-white/30 uppercase border-b border-tradr-green/[0.18]">
            <th className="text-left px-3 py-2 font-normal">Cycle</th>
            <th className="text-left px-3 py-2 font-normal">Top</th>
            <th className="text-left px-3 py-2 font-normal">Bottom</th>
            <th className="text-right px-3 py-2 font-normal">Drawdown</th>
            <th className="text-right px-3 py-2 font-normal">Rebound</th>
            <th className="text-right px-3 py-2 font-normal">Time Underwater</th>
            <th className="text-right px-3 py-2 font-normal">Halving→Top</th>
          </tr>
        </thead>
        <tbody>
          {BTC_CYCLES.map((c, i) => {
            const mult = REBOUND_MULTS[i]!;
            const reboundPct = Math.round((mult - 1) * 100);
            const h2t = halvingToTopMonths(c.topDate);
            return (
            <tr key={c.n} className="border-b border-tradr-green/[0.08]">
              <td className="px-3 py-2.5 text-white/50">#{c.n}</td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                <span className="text-white/85">{usd(c.topPrice)}</span>
                <span className="text-white/30 ml-2">{monthYear(c.topDate)}</span>
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                <span className="text-white/85">{usd(c.bottomPrice)}</span>
                <span className="text-white/30 ml-2">{monthYear(c.bottomDate)}</span>
              </td>
              <td className="px-3 py-2.5 text-right align-middle">
                <div className="text-[13px] font-bold text-tradr-red leading-none">{c.drawdownPct}%</div>
                <div className="mt-1.5 h-[3px] w-full rounded-sm bg-tradr-red/10 flex justify-end">
                  <div
                    className="h-full rounded-sm bg-tradr-red/70 transition-[width] duration-700 ease-out"
                    style={{ width: mounted ? `${Math.abs(c.drawdownPct)}%` : "0%" }}
                  />
                </div>
              </td>
              <td
                className="px-3 py-2.5 text-right align-middle"
                title={`${usd(c.bottomPrice)} → ${usd(nextTopFor(i))}  ·  +${reboundPct.toLocaleString("en-US")}%`}
              >
                <div className="text-[13px] font-bold text-tradr-green leading-none">×{roundMult(mult)}</div>
                <div className="mt-1.5 h-[3px] w-full rounded-sm bg-tradr-green/10 flex justify-end">
                  <div
                    className="h-full rounded-sm bg-tradr-green/70 transition-[width] duration-700 ease-out"
                    style={{ width: mounted ? `${reboundBarWidth(mult)}%` : "0%" }}
                  />
                </div>
              </td>
              <td className="px-3 py-2.5 text-right text-white/60 whitespace-nowrap">
                {underwater(c.daysUnderwater)}
              </td>
              <td className="px-3 py-2.5 text-right text-white/85 whitespace-nowrap">
                {h2t !== null ? `~${h2t} mo` : "—"}
              </td>
            </tr>
            );
          })}

          {/* Live NOW row — the ongoing drawdown from the Oct-2025 ATH. */}
          <tr className="bg-tradr-green/[0.07] border-t border-tradr-green/30">
            <td className="px-3 py-2.5 text-[12px] font-bold tracking-[1px] text-tradr-green whitespace-nowrap">
              <span className="inline-block w-1.5 h-1.5 mr-1.5 rounded-full bg-tradr-green align-middle animate-pulse" />
              NOW
            </td>
            <td className="px-3 py-2.5 whitespace-nowrap">
              <span className="text-white/85">{usd(BTC_ATH.price)}</span>
              <span className="text-white/30 ml-2">{monthYear(BTC_ATH.date)}</span>
            </td>
            <td className="px-3 py-2.5 text-white/30">—</td>
            <td className="px-3 py-2.5 text-right align-middle">
              <div className="text-[15px] font-bold text-tradr-red leading-none">
                {liveDrawdown !== null ? `${liveDrawdown}%` : "—"}
              </div>
              {liveDrawdown !== null && (
                <div className="mt-1.5 h-[3px] w-full rounded-sm bg-tradr-red/10 flex justify-end">
                  <div
                    className="h-full rounded-sm bg-tradr-red/70 transition-[width] duration-700 ease-out"
                    style={{ width: mounted ? `${Math.abs(liveDrawdown)}%` : "0%" }}
                  />
                </div>
              )}
            </td>
            <td className="px-3 py-2.5 text-right text-white/30">—</td>
            <td className="px-3 py-2.5 text-right text-white/60 whitespace-nowrap">
              {daysSinceAth} d … and counting
            </td>
            <td className="px-3 py-2.5 text-right text-white/85 whitespace-nowrap">
              {halvingToTopMonths(BTC_ATH.date) !== null ? `~${halvingToTopMonths(BTC_ATH.date)} mo` : "—"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
