/**
 * confluenceOiOverlap.ts — the Phase 1 OI overlap check. Downloads the last
 * 180 days of BTC open interest from the Binance archive (the study's
 * source) and from Gate.io + OKX (the live recorder's), and compares them
 * on daily 16:00 UTC points (see agents/confluence/live/oiOverlap.ts).
 * PASS = Pearson of the 24h and of the 7d % changes both ≥ 0.8; on FAIL the
 * OI features stay out of the live scorecard.
 *
 * Usage (from apps/api): pnpm agent:features:oi-overlap [--out report.md]
 * Public APIs only; reads and writes no database.
 */
import { writeFileSync } from "node:fs";
import { fetchBinanceOiDays } from "../agents/confluence/external/binanceOi";
import { fetchGateOi, fetchOkxOi } from "../agents/confluence/external/gateOkxOi";
import { oiOverlapCheck, OI_OVERLAP } from "../agents/confluence/live/oiOverlap";

const D = 86_400;
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const today = Math.floor(Date.now() / 1000 / D) * D;
  // Gate.io / OKX refuse anything older than 180 days; start one day inside that.
  const from = today - (OI_OVERLAP.days - 1) * D;
  console.log(`[oi-overlap] ${day(from)} → ${day(today)} (exclusive), daily points at ${OI_OVERLAP.hourUtc}:00 UTC`);
  const binance = await fetchBinanceOiDays({ fromDay: day(from), toDayExclusive: day(today) });
  console.log(`[oi-overlap] Binance: ${binance.points.length} points, ${binance.missingDays.length} missing day(s)`);
  const gate = await fetchGateOi({ from, toExclusive: today });
  const okx = await fetchOkxOi({ period: "1D", from, toExclusive: today });
  console.log(`[oi-overlap] Gate.io: ${gate.length} hourly points; OKX: ${okx.length} daily points`);

  const r = oiOverlapCheck({ binance: binance.points, gate, okx });
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
  const report = [
    `# OI overlap check (${day(today)})`,
    "",
    `Binance archive vs Gate.io + OKX, BTC open interest in USD, daily points at ${OI_OVERLAP.hourUtc}:00 UTC, ${r.first ? day(r.first) : "–"} → ${r.last ? day(r.last) : "–"}.`,
    "",
    "| | Points | Pearson r | Needed |",
    "|---|---|---|---|",
    `| 24h % change | ${r.n24h} | ${f(r.r24h)} | ≥ ${OI_OVERLAP.minCorrelation} |`,
    `| 7d % change | ${r.n7d} | ${f(r.r7d)} | ≥ ${OI_OVERLAP.minCorrelation} |`,
    "",
    `Daily points with all three sources: ${r.points}. Binance archive days missing: ${binance.missingDays.length ? binance.missingDays.join(", ") : "none"}.`,
    "",
    `**Result: ${r.pass ? "PASS: OI features may enter the live scorecard." : "FAIL: OI features are excluded from the live scorecard."}**`,
    "",
  ].join("\n");
  console.log(`\n${report}`);
  if (outIdx >= 0 && argv[outIdx + 1]) writeFileSync(argv[outIdx + 1]!, report);
}

main().catch((err) => {
  console.error("[oi-overlap] failed:", err);
  process.exit(1);
});
