/** Markdown report and per-trade CSV for a Swing Agent backtest. */
import { SWING_PARAMS as P } from "../swingParams";
import type { SwingCosts } from "../evaluateSwing";
import { LOW_CONFIDENCE_TRADES, tradeStats, type RunStats, type TradeStats } from "./metrics";
import type { BacktestTrade, Regime } from "./runSwingBacktest";

export interface ReportRun {
  stats: RunStats & { haltedAt: number | null; skippedDrift: number };
  trades: BacktestTrade[];
  reasonCounts: Record<string, number>;
}

export interface ReportInput {
  generatedAt: string;
  symbol: string;
  source: string;
  dataStart: number;
  dataEnd: number;
  testStart: number;
  testEnd: number;
  bars4h: number;
  gaps: { h1: number; h4: number; list: string[] };
  fallbackBars: number;
  costs: SwingCosts;
  regimeShare: Record<Regime, number>;
  variants: Array<{ variant: "A" | "B"; base: ReportRun; adx25: ReportRun; stress: ReportRun }>;
  buyAndHold: { returnPct: number; cagrPct: number; maxDrawdownPct: number };
}

const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const rr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pf = (s: TradeStats) => (s.trades === 0 ? "—" : s.profitFactor === null ? "∞" : s.profitFactor.toFixed(2));
const conf = (s: TradeStats) => (s.lowConfidence ? `⚠ low confidence (n=${s.trades})` : "ok");
const RUN_LABEL = { base: "base", adx25: "ADX ≥ 25", stress: "fees + slippage ×2" } as const;

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function groupRows(trades: BacktestTrade[], keyOf: (t: BacktestTrade) => string, keys: string[], extra?: (k: string) => string): string[][] {
  return keys.map((k) => {
    const s = tradeStats(trades.filter((t) => keyOf(t) === k));
    return [k, ...(extra ? [extra(k)] : []), String(s.trades), pct(s.winRate), rr(s.avgR), pf(s), usd(s.netPnlUsd), conf(s)];
  });
}

const REASON_TEXT: Record<string, string> = {
  entry: "entered a trade",
  time_stop: "closed on the 42-bar time stop",
  position_open: "held an open position",
  killed: "kill switch on (drawdown halt)",
  halted_drawdown: "drawdown halt tripped",
  daily_loss_limit: "daily loss limit",
  max_trades_today: "max entries per day",
  cooldown: "cooldown after an exit",
  bias_neutral: "weekly bias neutral (between SMA 50 and 200)",
  daily_disagrees: "daily close disagrees with the weekly bias",
  adx_weak: "4h ADX under the threshold",
  no_setup: "no entry setup on this bar",
  stop_invalid: "stop outside 0.5%–8%",
  room_to_target: "opposing S/R under 1.5R away",
  target_too_close: "target under 1.5R",
};

function variantSection(v: ReportInput["variants"][number], share: Record<Regime, number>): string {
  const { trades, reasonCounts, stats } = v.base;
  const years = [...new Set(trades.map((t) => new Date(t.entryTime * 1000).getUTCFullYear()))].sort().map(String);
  const yearOf = (t: BacktestTrade) => String(new Date(t.entryTime * 1000).getUTCFullYear());
  const regimes: Regime[] = ["trending", "transitional", "ranging", "unknown"];
  const exits = ["target", "stop", "time", "end_of_data"];
  const total = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
  const reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
  const name = v.variant === "A" ? "4h pullback to EMA 20 (EMA 50 structure, RSI 14 band)" : "4h UT Bot flip (key 1, ATR 10)";

  return [
    `## Variant ${v.variant}: ${name}`,
    "",
    `Base run: ${stats.trades} trades, ${pct(stats.winRate)} win rate, average ${rr(stats.avgR)}, ` +
      `profit factor ${pf(stats)}, return ${pct(stats.returnPct)}, max drawdown ${pct(stats.maxDrawdownPct)}.` +
      (stats.haltedAt ? ` **The 15% drawdown halt tripped on ${date(stats.haltedAt)}; no entries after that.**` : "") +
      (stats.skippedDrift ? ` ${stats.skippedDrift} entries skipped by the drift guard (next open > 0.25R away).` : ""),
    "",
    "### By year (entry year, base run)",
    "",
    table(["Year", "Trades", "Win rate", "Avg R", "PF", "Net P&L", "Confidence"], groupRows(trades, yearOf, years)),
    "",
    "### By regime (daily ADX 14 at the decision, base run)",
    "",
    "Trending ≥ 25, transitional 20–25, ranging < 20. \"Share of bars\" is how much of the tested period each regime covered.",
    "",
    table(["Regime", "Share of bars", "Trades", "Win rate", "Avg R", "PF", "Net P&L", "Confidence"],
      groupRows(trades, (t) => t.regime, regimes, (k) => pct(share[k as Regime]))),
    "",
    "### Exit reasons (base run)",
    "",
    table(["Exit", "Trades", "Win rate", "Avg R", "PF", "Net P&L", "Confidence"], groupRows(trades, (t) => t.exitReason, exits)),
    "",
    "### Why it did nothing (every 4h evaluation, base run)",
    "",
    table(["Reason code", "Meaning", "Evaluations", "Share"],
      reasons.map(([code, n]) => [`\`${code}\``, REASON_TEXT[code] ?? code, n.toLocaleString("en-US"), pct(total ? n / total : 0)])),
  ].join("\n");
}

export function renderReport(r: ReportInput): string {
  const summaryRows: string[][] = [];
  for (const v of r.variants) {
    for (const key of ["base", "adx25", "stress"] as const) {
      const s = v[key].stats;
      summaryRows.push([
        v.variant, RUN_LABEL[key], String(s.trades), pct(s.winRate), rr(s.avgR), usd(s.expectancyUsd), pf(s),
        pct(s.returnPct), pct(s.cagrPct), pct(s.maxDrawdownPct), String(s.longestLosingStreak), pct(s.timeInMarketPct), conf(s),
      ]);
    }
  }
  const bh = r.buyAndHold;
  return [
    `# Swing Agent backtest: ${r.symbol} 4h, Variant A vs B`,
    "",
    `Generated ${r.generatedAt} by \`pnpm agent:backtest\`. Rules and numbers: \`apps/api/src/agents/swing/swingParams.ts\` ` +
      "(fixed before this run; nothing was tuned on it).",
    "",
    `- **Tested window:** ${date(r.testStart)} → ${date(r.testEnd)} (${r.bars4h.toLocaleString("en-US")} 4h bars), warm-up excluded. ` +
      `The weekly SMA 200 needs 200 closed weeks, so this is the first bar both variants can trade.`,
    `- **Data:** ${r.source} ${r.symbol}, ${date(r.dataStart)} → ${date(r.dataEnd)}: 1h and 1d native, 4h rolled up from 1h, 1w from 1d.`,
    `- **Costs per side:** taker fee ${r.costs.takerFeeBps} bps + slippage ${r.costs.slippageBps} bps. Stress run: both doubled.`,
    `- **Start equity:** $100,000, risk ${pct(P.risk.perTrade)} per trade, notional ≤ 1x equity.`,
    "",
    "## Summary",
    "",
    `Results based on fewer than ${LOW_CONFIDENCE_TRADES} trades are flagged **⚠ low confidence**: the sample is too small to tell skill from luck.`,
    "",
    table(
      ["Variant", "Run", "Trades", "Win rate", "Avg R", "Expectancy / trade", "PF", "Return", "CAGR", "Max DD", "Longest losing streak", "Time in market", "Confidence"],
      summaryRows,
    ),
    "",
    `Buy and hold over the same window: return ${pct(bh.returnPct)}, CAGR ${pct(bh.cagrPct)}, max drawdown ${pct(bh.maxDrawdownPct)}.`,
    "",
    ...r.variants.flatMap((v) => [variantSection(v, r.regimeShare), ""]),
    "## Buy and hold",
    "",
    table(["", "Return", "CAGR", "Max DD"], [
      ["Buy and hold", pct(bh.returnPct), pct(bh.cagrPct), pct(bh.maxDrawdownPct)],
      ...r.variants.map((v) => [`Variant ${v.variant} (base)`, pct(v.base.stats.returnPct), pct(v.base.stats.cagrPct), pct(v.base.stats.maxDrawdownPct)]),
    ]),
    "",
    "Buy and hold buys at the first tested bar's open and sells at the last close, paying slippage and the fee once each way; its drawdown is marked at 4h closes.",
    "",
    "## Method",
    "",
    "- **Same rules as live:** every decision is `evaluateSwing(snapshotAt(series, k), account, variant, costs)`, the function the live agent will call.",
    "- **No lookahead:** 4h indicators are causal; S/R levels come from `activeSRLevelsAt` (4h) and `srHtfLevelsAt` (1d), daily/weekly values from `htfValueAt`, all as of the 4h close. A test cuts the data at several bars and checks that everything before the cut is identical.",
    "- **Entries:** decided at the 4h close, filled at the next 4h open ± slippage + taker fee, sized by the plan. Skipped if that open is more than 0.25R from the decision close (the live drift guard).",
    "- **Exits:** stop and target are walked on the four 1h bars inside each 4h bar. An hour that opens beyond the stop or target fills at its open; an hour that trades through both counts as the stop. Fills pay slippage against the trade + the taker fee. The 42-bar time stop fills at the next 4h open. A position open at the end closes at the last close (`end_of_data`).",
    "- **R:** net P&L ÷ (qty × |entry fill − stop|). Profit factor = gross wins ÷ gross losses, net of costs.",
    "- **Limits applied:** 1 position, 2 entries per UTC day, 1-bar cooldown, −3% daily loss stop, 15% drawdown halt (never re-armed in the backtest).",
    "- **ADX ≥ 25 line:** the same run with the 4h ADX entry threshold at 25 instead of 20 (sensitivity only; the approved threshold is 20).",
    `- **Data gaps:** ${r.gaps.h1} gaps in the 1h series, ${r.gaps.h4} in the 4h series${r.gaps.list.length ? ` (${r.gaps.list.join("; ")})` : ""}. ` +
      `${r.fallbackBars.toLocaleString("en-US")} in-position 4h bars had no complete 1h breakdown and were walked as one bar.`,
    "",
  ].join("\n");
}

const num = (v: number | null) => (v === null ? "" : String(Number(v.toFixed(8))));

export function renderTradesCsv(runs: Array<{ variant: string; run: string; trades: BacktestTrade[] }>): string {
  const head = "variant,run,side,entry_time,exit_time,entry_price,exit_price,stop,target,qty,r_multiple,pnl_usd,fees_usd,exit_reason,bars_held,stop_source,target_source,adx_4h,regime";
  const rows = runs.flatMap(({ variant, run, trades }) => trades.map((t) => [
    variant, run, t.side, iso(t.entryTime), iso(t.exitTime), num(t.entryPrice), num(t.exitPrice), num(t.stop), num(t.target),
    num(t.qty), num(t.rMultiple), num(t.pnlUsd), num(t.feesUsd), t.exitReason, String(t.barsHeld), t.stopSource, t.targetSource,
    num(t.adx), t.regime,
  ].join(",")));
  return [head, ...rows, ""].join("\n");
}
