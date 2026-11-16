/**
 * Swing Agent v2 report for one period (in-sample or out-of-sample): the
 * verdict against the pre-registered pass bar first, then every table split
 * into all / long / short, the two baselines and buy-and-hold.
 */
import { SWING_PARAMS } from "../swingParams";
import { SWING_PARAMS_V2 as P, SWING_V2_PASS_BAR as BAR, SWING_BASELINES as B } from "../swingParamsV2";
import type { SwingCosts } from "../evaluateSwing";
import type { BaselineTrade } from "./baselines";
import { LOW_CONFIDENCE_TRADES, tradeStats, type RunStats, type TradeStats } from "./metrics";
import type { BacktestTrade, Regime } from "./runSwingBacktest";
import type { RoomSample } from "./runSwingV2";

export type Period = "in-sample" | "out-of-sample";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface V2ReportRun {
  stats: RunStats & { haltedAt: number | null; skippedDrift: number };
  trades: BacktestTrade[];
  decisions: Array<{ reasonCode: string; side: "long" | "short" | null }>;
  room: RoomSample[];
}

export interface BaselineReportRun {
  stats: RunStats;
  trades: BaselineTrade[];
}

export interface V2ReportInput {
  period: Period;
  generatedAt: string;
  symbol: string;
  source: string;
  dataStart: number;
  /** Exclusive: no candle at or after this was loaded. */
  dataEnd: number;
  testStart: number;
  testEnd: number;
  bars4h: number;
  gaps: { h1: number; h4: number; list: string[] };
  fallbackBars: number;
  costs: SwingCosts;
  regimeShare: Record<Regime, number>;
  v2: { base: V2ReportRun; stress: V2ReportRun };
  baselineA: { base: BaselineReportRun; stress: BaselineReportRun };
  baselineB: { base: BaselineReportRun; stress: BaselineReportRun };
  buyAndHold: { returnPct: number; cagrPct: number; maxDrawdownPct: number; mar: number | null };
}

export interface VerdictCheck { label: string; value: string; threshold: string; pass: boolean }

// ── formatting ──

const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const rr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pf = (s: TradeStats) => (s.trades === 0 ? "—" : s.profitFactor === null ? "∞" : s.profitFactor.toFixed(2));
const conf = (s: TradeStats) => (s.lowConfidence ? `⚠ low confidence (n=${s.trades})` : "ok");
const marText = (m: number | null) => (m === null ? "—" : m.toFixed(2));

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

type Sided = { side: "long" | "short"; pnlUsd: number; rMultiple: number };
const SIDES = ["all", "long", "short"] as const;
const bySide = <T extends Sided>(trades: T[], side: (typeof SIDES)[number]) =>
  side === "all" ? trades : trades.filter((t) => t.side === side);

/** MAR comparison where null (no drawdown) counts as +∞ for a positive CAGR and −∞ otherwise. */
function marValue(m: number | null, cagr: number): number {
  if (m !== null) return m;
  return cagr > 0 ? Infinity : cagr < 0 ? -Infinity : 0;
}

// ── verdict ──

export function verdictV2(r: Pick<V2ReportInput, "period" | "v2" | "baselineB">): { verdict: Verdict; checks: VerdictCheck[]; lowConfidence: boolean } {
  const base = r.v2.base.stats;
  const stress = r.v2.stress.stats;
  const b = r.baselineB.base.stats;
  const mar = marValue(base.mar, base.cagrPct);
  const marB = marValue(b.mar, b.cagrPct);
  if (r.period === "in-sample") {
    const I = BAR.inSample;
    const checks: VerdictCheck[] = [
      { label: "Trades (base run)", value: String(base.trades), threshold: `>= ${I.minTrades}`, pass: base.trades >= I.minTrades },
      { label: "Expectancy, fees + slippage ×2", value: rr(stress.avgR), threshold: `> ${I.minStressExpectancyR.toFixed(2)}R`, pass: stress.avgR > I.minStressExpectancyR },
      { label: "MAR vs baseline (b), base costs", value: `${marText(base.mar)} vs ${marText(b.mar)}`, threshold: ">= baseline (b)", pass: mar >= marB - 1e-9 },
    ];
    const verdict: Verdict = !checks[0]!.pass ? "INCONCLUSIVE" : checks.every((c) => c.pass) ? "PASS" : "FAIL";
    return { verdict, checks, lowConfidence: base.trades < LOW_CONFIDENCE_TRADES };
  }
  const O = BAR.outOfSample;
  const marFloor = marB - O.marWithinOfBaselineB * Math.abs(marB);
  const checks: VerdictCheck[] = [
    { label: "Expectancy, normal costs", value: rr(base.avgR), threshold: `> ${O.minExpectancyR.toFixed(2)}R`, pass: base.avgR > O.minExpectancyR },
    { label: "Max drawdown", value: pct(base.maxDrawdownPct), threshold: `<= ${pct(O.maxDrawdownPct)}`, pass: base.maxDrawdownPct <= O.maxDrawdownPct + 1e-9 },
    { label: "MAR within 25% of baseline (b)", value: `${marText(base.mar)} vs ${marText(b.mar)}`, threshold: `>= ${Number.isFinite(marFloor) ? marFloor.toFixed(2) : String(marFloor)}`, pass: mar >= marFloor - 1e-9 },
  ];
  return { verdict: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, lowConfidence: base.trades < LOW_CONFIDENCE_TRADES };
}

// ── sections ──

const REASON_TEXT: Record<string, string> = {
  entry: "entered a trade",
  trend_exit: "closed: 4h close across EMA 50",
  position_open: "held an open position",
  killed: "kill switch on (drawdown halt)",
  halted_drawdown: "drawdown halt tripped",
  daily_loss_limit: "daily loss limit",
  max_trades_today: "max entries per day",
  cooldown: "cooldown after an exit",
  warmup: "not enough history",
  bias_neutral: "weekly close exactly on SMA 50",
  daily_disagrees: "daily close disagrees with the weekly bias",
  adx_weak: "4h ADX under 20",
  no_setup: "no pullback setup on this bar",
  stop_invalid: "stop outside 0.5%–8%",
  room_htf: "opposing daily/weekly S/R under 1.0R away",
};

function summaryRows(label: string, run: string, stats: RunStats, trades: Sided[], longOnly = false): string[][] {
  return SIDES.map((side) => {
    const t = side === "all" ? stats : tradeStats(bySide(trades, side));
    const portfolio = side === "all";
    const note = longOnly && side === "short" ? " (long only)" : "";
    return [
      label, run, side + note, String(t.trades), pct(t.winRate), rr(t.avgR), usd(t.expectancyUsd), pf(t), usd(t.netPnlUsd),
      portfolio ? pct(stats.returnPct) : "—", portfolio ? pct(stats.cagrPct) : "—", portfolio ? pct(stats.maxDrawdownPct) : "—",
      portfolio ? marText(stats.mar) : "—", portfolio ? pct(stats.timeInMarketPct) : "—", conf(t),
    ];
  });
}

function groupTable<T extends Sided>(trades: T[], keyOf: (t: T) => string, keys: string[], firstHead: string, extra?: { head: string; of: (k: string) => string }): string {
  const rows: string[][] = [];
  for (const k of keys) {
    for (const side of SIDES) {
      const s = tradeStats(bySide(trades, side).filter((t) => keyOf(t) === k));
      rows.push([k, ...(extra ? [side === "all" ? extra.of(k) : ""] : []), side, String(s.trades), pct(s.winRate), rr(s.avgR), pf(s), usd(s.netPnlUsd), conf(s)]);
    }
  }
  return table([firstHead, ...(extra ? [extra.head] : []), "Side", "Trades", "Win rate", "Avg R", "PF", "Net P&L", "Confidence"], rows);
}

function funnelTable(decisions: V2ReportRun["decisions"]): string {
  const counts = new Map<string, { long: number; short: number; none: number }>();
  for (const d of decisions) {
    const c = counts.get(d.reasonCode) ?? { long: 0, short: 0, none: 0 };
    c[d.side ?? "none"]++;
    counts.set(d.reasonCode, c);
  }
  const total = decisions.length;
  const rows = [...counts.entries()]
    .map(([code, c]) => ({ code, c, n: c.long + c.short + c.none }))
    .sort((a, b) => b.n - a.n)
    .map(({ code, c, n }) => [
      `\`${code}\``, REASON_TEXT[code] ?? code, c.long.toLocaleString("en-US"), c.short.toLocaleString("en-US"), c.none.toLocaleString("en-US"),
      n.toLocaleString("en-US"), pct(total ? n / total : 0),
    ]);
  return table(["Reason code", "Meaning", "Long bias", "Short bias", "No side", "Total", "Share"], rows);
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function roomTable(room: RoomSample[]): string {
  const f = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}R`);
  const rows = SIDES.map((side) => {
    const s = side === "all" ? room : room.filter((x) => x.side === side);
    const nums = s.flatMap((x) => (x.roomR === "none" ? [] : [x.roomR])).sort((a, b) => a - b);
    const none = s.length - nums.length;
    const ok = nums.filter((v) => v >= P.room.minR - 1e-9).length + none;
    return [side, String(s.length), String(none), f(quantile(nums, 0.25)), f(quantile(nums, 0.5)), f(quantile(nums, 0.75)), s.length ? pct(ok / s.length) : "—"];
  });
  return table(["Side", "Evaluations reaching the check", "No opposing level", "25th pct", "Median", "75th pct", `Pass (>= ${P.room.minR}R)`], rows);
}

// ── report ──

export function renderReportV2(r: V2ReportInput): string {
  const { verdict, checks, lowConfidence } = verdictV2(r);
  const v = r.v2.base.stats;
  const isIS = r.period === "in-sample";
  const bars = isIS ? BAR.inSample : null;
  const compare = [
    { name: "baseline (a) weekly trend, full size", s: r.baselineA.base.stats },
    { name: "baseline (b) weekly trend, 1% risk", s: r.baselineB.base.stats },
    { name: "buy and hold", s: r.buyAndHold },
  ];
  const mar = marValue(v.mar, v.cagrPct);
  const beaten = compare.filter((c) => marValue(c.s.mar, c.s.cagrPct) > mar);
  const years = [...new Set(r.v2.base.trades.map((t) => new Date(t.entryTime * 1000).getUTCFullYear()))].sort().map(String);
  const yearOf = (t: { entryTime: number }) => String(new Date(t.entryTime * 1000).getUTCFullYear());
  const regimes: Regime[] = ["trending", "transitional", "ranging", "unknown"];

  const lines = [
    `# Swing Agent v2 backtest: ${r.symbol} 4h, ${r.period} (${date(r.testStart)} → ${date(r.testEnd)})`,
    "",
    `**Verdict: ${verdict}** against the ${r.period} pass bar fixed on 2026-11-15, before this run.` +
      (verdict === "INCONCLUSIVE" ? ` Only ${v.trades} trades (needs ${bars!.minTrades}): too few to tell skill from luck, so this is not a pass.` : "") +
      (lowConfidence && verdict !== "INCONCLUSIVE" ? ` ⚠ Low confidence: ${v.trades} trades.` : ""),
    "",
    table(["Check", "Result", "Needs", "Pass"], checks.map((c) => [c.label, c.value, c.threshold, c.pass ? "✅" : "❌"])),
    "",
    ...(v.haltedAt
      ? [`**The 15% drawdown halt tripped on ${date(v.haltedAt)} (base run)** and is never re-armed in a backtest, so ` +
        `${pct((r.v2.base.decisions.filter((d) => d.reasonCode === "killed").length) / Math.max(1, r.v2.base.decisions.length))} ` +
        "of the period's evaluations were blocked by it. The trade count reflects that.", ""]
      : []),
    beaten.length
      ? `**A baseline beats v2 on MAR (CAGR ÷ max drawdown):** ${beaten.map((c) => `${c.name} ${marText(c.s.mar)}`).join("; ")} vs v2 ${marText(v.mar)}.`
      : `v2's MAR (${marText(v.mar)}) is at least every baseline's (${compare.map((c) => `${c.name} ${marText(c.s.mar)}`).join("; ")}).`,
    "",
    isIS
      ? (verdict === "PASS"
        ? "Out-of-sample (2024-01-01 → today) has NOT been run; it runs once, only after this in-sample result is approved."
        : "Per the pass bar, out-of-sample is **not** run: that data stays unseen.")
      : "This is the single out-of-sample run. It is not re-run after any change; a change is a new version that needs new unseen data.",
    "",
    `Generated ${r.generatedAt} by \`pnpm agent:backtest:v2 --period ${isIS ? "is" : "oos"}\`. Rules and numbers: ` +
      "`apps/api/src/agents/swing/swingParamsV2.ts` (fixed before this run; nothing tuned on it).",
    "",
    `- **Period:** ${date(r.testStart)} → ${date(r.testEnd)} (${r.bars4h.toLocaleString("en-US")} 4h bars), fresh $100,000, its own drawdown halt. ` +
      `Candles loaded: ${date(r.dataStart)} → ${date(r.dataEnd)} (exclusive)${isIS ? ": nothing from the out-of-sample period was read" : ""}. Earlier bars only warm up the indicators.`,
    `- **Data:** ${r.source} ${r.symbol}: 1h and 1d native, 4h rolled up from 1h, 1w from 1d.`,
    `- **Costs per side:** taker fee ${r.costs.takerFeeBps} bps + slippage ${r.costs.slippageBps} bps. Stress run: both doubled.`,
    `- **Risk:** ${pct(P.risk.perTrade)} per trade, notional ≤ 1x equity. MAR = CAGR ÷ max drawdown.`,
    "",
    "## Summary",
    "",
    `Every row is split into all / long / short. Return, CAGR, max DD, MAR and time in market are whole-portfolio numbers, so they only appear on the "all" rows. Results on fewer than ${LOW_CONFIDENCE_TRADES} trades are flagged **⚠ low confidence**. The baselines are long only. Their R is per 1% of equity at entry for (a), and per the stop distance for (b).`,
    "",
    table(
      ["Strategy", "Run", "Side", "Trades", "Win rate", "Avg R", "Expectancy / trade", "PF", "Net P&L", "Return", "CAGR", "Max DD", "MAR", "Time in market", "Confidence"],
      [
        ...summaryRows("v2 (Variant A)", "base", v, r.v2.base.trades),
        ...summaryRows("v2 (Variant A)", "fees + slippage ×2", r.v2.stress.stats, r.v2.stress.trades),
        ...summaryRows("baseline (b) 1% risk", "base", r.baselineB.base.stats, r.baselineB.base.trades, true),
        ...summaryRows("baseline (b) 1% risk", "fees + slippage ×2", r.baselineB.stress.stats, r.baselineB.stress.trades, true),
        ...summaryRows("baseline (a) full size", "base", r.baselineA.base.stats, r.baselineA.base.trades, true),
        ...summaryRows("baseline (a) full size", "fees + slippage ×2", r.baselineA.stress.stats, r.baselineA.stress.trades, true),
      ],
    ),
    "",
    "## v2 against the baselines (base costs)",
    "",
    table(["Strategy", "Trades", "Return", "CAGR", "Max DD", "MAR", "Time in market"], [
      ["v2 (Variant A)", String(v.trades), pct(v.returnPct), pct(v.cagrPct), pct(v.maxDrawdownPct), marText(v.mar), pct(v.timeInMarketPct)],
      ["baseline (b) weekly trend, 1% risk", String(r.baselineB.base.stats.trades), pct(r.baselineB.base.stats.returnPct), pct(r.baselineB.base.stats.cagrPct),
        pct(r.baselineB.base.stats.maxDrawdownPct), marText(r.baselineB.base.stats.mar), pct(r.baselineB.base.stats.timeInMarketPct)],
      ["baseline (a) weekly trend, full size", String(r.baselineA.base.stats.trades), pct(r.baselineA.base.stats.returnPct), pct(r.baselineA.base.stats.cagrPct),
        pct(r.baselineA.base.stats.maxDrawdownPct), marText(r.baselineA.base.stats.mar), pct(r.baselineA.base.stats.timeInMarketPct)],
      ["buy and hold", "1", pct(r.buyAndHold.returnPct), pct(r.buyAndHold.cagrPct), pct(r.buyAndHold.maxDrawdownPct), marText(r.buyAndHold.mar), "100.00%"],
    ]),
    "",
    `Baseline (a): long 100% of equity while the last weekly close > SMA ${B.weeklySma}w, else flat. Baseline (b): the same signal, stop = weekly close − ${B.stopAtrMult} × weekly ATR(${B.atrPeriod}) (fixed), ${pct(B.riskPerTrade)} risk, ≤ 1x notional; re-enters at the next weekly close still above after a stop-out. Buy and hold buys at the period's first open and sells at its last close.`,
    "",
    "## v2: by year (entry year, base run)",
    "",
    groupTable(r.v2.base.trades, yearOf, years, "Year"),
    "",
    "## v2: by regime (daily ADX 14 at the decision, base run)",
    "",
    "Trending ≥ 25, transitional 20–25, ranging < 20. \"Share of bars\" is how much of the period each regime covered.",
    "",
    groupTable(r.v2.base.trades, (t) => t.regime, regimes, "Regime", { head: "Share of bars", of: (k) => pct(r.regimeShare[k as Regime]) }),
    "",
    "## v2: exit reasons (base run)",
    "",
    "`stop` = the initial hard stop; `trend` = a 4h close across EMA 50, filled at the next open; `end_of_data` = still open at the period end, closed at its last close.",
    "",
    groupTable(r.v2.base.trades, (t) => t.exitReason, ["stop", "trend", "end_of_data"], "Exit"),
    "",
    "## Baseline (b): exit reasons (base run)",
    "",
    groupTable(r.baselineB.base.trades, (t) => t.exitReason, ["stop", "signal", "end_of_data"], "Exit"),
    "",
    "## v2: room to daily/weekly S/R (every evaluation that reached the check, base run)",
    "",
    `v1 measured this on 4h + daily levels: median 0.61R against a 1.5R requirement. v2 uses daily (pivots ${SWING_PARAMS.sr1d.left}/${SWING_PARAMS.sr1d.right}) and weekly (pivots ${P.sr1w.left}/${P.sr1w.right}) levels only, needing ${P.room.minR}R.`,
    "",
    roomTable(r.v2.base.room),
    "",
    "## v2: why it did nothing (every 4h evaluation, base run)",
    "",
    "Side = the weekly bias the rules tested (the position's side while holding).",
    "",
    funnelTable(r.v2.base.decisions),
    "",
    "## Method",
    "",
    "- **Same rules as live:** every decision is `evaluateSwingV2(snapshotAt(series, k), account, costs)`, the function the live agent will call.",
    "- **No lookahead:** 4h indicators are causal; S/R levels come from `activeSRLevelsAt` (4h), `srHtfLevelsAt` (1d and 1w), and daily/weekly values from `htfValueAt`, all as of the 4h close.",
    "- **Entries:** decided at the 4h close, filled at the next 4h open ± slippage + taker fee, sized by the plan. Skipped if that open is more than 0.25R from the decision close (the live drift guard)." +
      (r.v2.base.stats.skippedDrift ? ` ${r.v2.base.stats.skippedDrift} entries skipped this way (base run).` : ""),
    "- **Exits:** the initial stop never moves and is walked on the four 1h bars inside each 4h bar (an hour opening beyond it fills at its open). A 4h close across EMA 50 exits at the next 4h open. No target and no time stop. Fills pay slippage against the trade + the taker fee.",
    "- **R:** net P&L ÷ (qty × |entry fill − stop|). Profit factor = gross wins ÷ gross losses, net of costs. Expectancy in the verdict = average R per trade.",
    "- **Limits applied:** 1 position, 2 entries per UTC day, 1-bar cooldown, −3% daily loss stop, 15% drawdown halt (never re-armed in the backtest)." +
      (r.v2.base.stats.haltedAt ? ` **The halt tripped on ${date(r.v2.base.stats.haltedAt)}; no entries after that (base run).**` : ""),
    `- **Data gaps (loaded candles):** ${r.gaps.h1} gaps in the 1h series, ${r.gaps.h4} in the 4h series${r.gaps.list.length ? ` (${r.gaps.list.join("; ")})` : ""}. ` +
      `${r.fallbackBars.toLocaleString("en-US")} in-position 4h bars had no complete 1h breakdown and were walked as one bar.`,
    "",
  ];
  return lines.join("\n");
}

const num = (v: number | null) => (v === null ? "" : String(Number(v.toFixed(8))));
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function renderV2TradesCsv(rows: Array<{ strategy: string; run: string; trades: Array<BacktestTrade | BaselineTrade> }>): string {
  const head = "strategy,run,side,entry_time,exit_time,entry_price,exit_price,stop,qty,r_multiple,pnl_usd,fees_usd,exit_reason,bars_held,stop_source,adx_4h,regime";
  const out = rows.flatMap(({ strategy, run, trades }) => trades.map((t) => {
    const a = "regime" in t ? t : null;
    return [
      strategy, run, t.side, iso(t.entryTime), iso(t.exitTime), num(t.entryPrice), num(t.exitPrice), num(t.stop), num(t.qty), num(t.rMultiple),
      num(t.pnlUsd), num(t.feesUsd), t.exitReason, a ? String(a.barsHeld) : "", a ? a.stopSource : "", a ? num(a.adx) : "", a ? a.regime : "",
    ].join(",");
  }));
  return [head, ...out, ""].join("\n");
}
