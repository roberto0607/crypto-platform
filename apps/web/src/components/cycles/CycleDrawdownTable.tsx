import { BTC_CYCLES, BTC_ATH } from "@/lib/btcCycles";

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

const MAX_DD = 94; // cycle 1, the deepest — normalizes the magnitude bars

interface Props {
  currentPrice?: number;
}

export default function CycleDrawdownTable({ currentPrice }: Props) {
  const hasPrice = currentPrice !== undefined && Number.isFinite(currentPrice);
  const liveDrawdown = hasPrice
    ? Math.round(((currentPrice! - BTC_ATH.price) / BTC_ATH.price) * 100)
    : null;
  const daysSinceAth = Math.floor((Date.now() - Date.parse(BTC_ATH.date)) / 86_400_000);

  return (
    <div className="overflow-x-auto border border-tradr-green/[0.18] bg-tradr-bg2/40">
      <table className="w-full font-mono text-[11px] border-collapse">
        <thead>
          <tr className="text-[9px] tracking-[2px] text-white/30 uppercase border-b border-tradr-green/[0.18]">
            <th className="text-left px-3 py-2 font-normal">Cycle</th>
            <th className="text-left px-3 py-2 font-normal">Top</th>
            <th className="text-left px-3 py-2 font-normal">Bottom</th>
            <th className="text-right px-3 py-2 font-normal">Drawdown</th>
            <th className="text-right px-3 py-2 font-normal">Time Underwater</th>
          </tr>
        </thead>
        <tbody>
          {BTC_CYCLES.map((c) => (
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
                <div
                  className="mt-1 h-[3px] bg-tradr-red/70 rounded-sm"
                  style={{ width: `${(Math.abs(c.drawdownPct) / MAX_DD) * 100}%`, marginLeft: "auto" }}
                />
              </td>
              <td className="px-3 py-2.5 text-right text-white/60 whitespace-nowrap">
                {underwater(c.daysUnderwater)}
              </td>
            </tr>
          ))}

          {/* Live NOW row — the ongoing drawdown from the Oct-2025 ATH. */}
          <tr className="bg-tradr-green/[0.07] border-t border-tradr-green/30">
            <td className="px-3 py-2.5 text-[12px] font-bold tracking-[1px] text-tradr-green">NOW</td>
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
                <div
                  className="mt-1 h-[3px] bg-tradr-red/70 rounded-sm"
                  style={{ width: `${(Math.abs(liveDrawdown) / MAX_DD) * 100}%`, marginLeft: "auto" }}
                />
              )}
            </td>
            <td className="px-3 py-2.5 text-right text-white/60 whitespace-nowrap">
              {daysSinceAth} d … and counting
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
