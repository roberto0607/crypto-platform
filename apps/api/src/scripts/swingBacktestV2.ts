/**
 * swingBacktestV2.ts — backtest Swing Agent v2 (Variant A only) on stored
 * BTC-USD candles for ONE period and write a Markdown report + per-trade CSV.
 *
 * Usage (from apps/api, DATABASE_URL at a DB with candle history; never
 * production):
 *   pnpm agent:backtest:v2 --period is
 *   pnpm agent:backtest:v2 --period oos --confirm-oos   # once, after the in-sample result is approved
 *
 * In-sample (2019-05-01 → 2023-12-31) loads NO candle at or after 2024-01-01,
 * so the out-of-sample data is never read by an in-sample run. Out-of-sample
 * refuses to run without --confirm-oos.
 *
 * Read-only: it only SELECTs candles and the pair's taker fee.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db/pool";
import type { Candle } from "../indicators/shared";
import type { SwingCosts } from "../agents/swing/evaluateSwing";
import { evaluateSwingV2 } from "../agents/swing/evaluateSwingV2";
import { buildSwingSeries, snapshotAt } from "../agents/swing/swingSeries";
import { SWING_V2_PERIODS } from "../agents/swing/swingParamsV2";
import { runBaseline, type BaselineKind } from "../agents/swing/backtest/baselines";
import { buyAndHold, summarize } from "../agents/swing/backtest/metrics";
import { renderReportV2, renderV2TradesCsv, verdictV2, type BaselineReportRun, type V2ReportRun } from "../agents/swing/backtest/reportV2";
import { regimeShare, type BacktestCandles } from "../agents/swing/backtest/runSwingBacktest";
import { indexAtOrAfter, runSwingV2 } from "../agents/swing/backtest/runSwingV2";

const SLIPPAGE_BPS = 5;
const START_EQUITY = 100_000;
const TF_SEC = { "1h": 3_600, "4h": 14_400, "1d": 86_400, "1w": 604_800 } as const;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Closed candles whose close is at or before `end`. */
async function loadCandles(pairId: string, tf: keyof typeof TF_SEC, end: number): Promise<Candle[]> {
  const { rows } = await pool.query<{ t: string; open: string; high: string; low: string; close: string; volume: string }>(
    `SELECT extract(epoch FROM ts)::bigint::text AS t, open, high, low, close, volume
       FROM candles
      WHERE pair_id = $1 AND timeframe = $2 AND extract(epoch FROM ts) + $3 <= $4
      ORDER BY ts`,
    [pairId, tf, TF_SEC[tf], end],
  );
  return rows.map((r) => ({
    time: Number(r.t), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
  }));
}

function gaps(cs: Candle[], sec: number): Array<{ from: number; missing: number }> {
  const out: Array<{ from: number; missing: number }> = [];
  for (let i = 1; i < cs.length; i++) {
    const d = cs[i]!.time - cs[i - 1]!.time;
    if (d > sec) out.push({ from: cs[i - 1]!.time + sec, missing: d / sec - 1 });
  }
  return out;
}

async function main(): Promise<void> {
  const periodArg = arg("period");
  if (periodArg !== "is" && periodArg !== "oos") throw new Error("--period is|oos is required");
  if (periodArg === "oos" && !process.argv.includes("--confirm-oos")) {
    throw new Error("out-of-sample runs once, after the in-sample result is approved: pass --confirm-oos to run it");
  }
  const isIS = periodArg === "is";
  const start = utc(isIS ? SWING_V2_PERIODS.inSample.start : SWING_V2_PERIODS.outOfSample.start);
  const today = Math.floor(Date.now() / 86_400_000) * 86_400;
  const end = isIS ? utc(SWING_V2_PERIODS.inSample.endExclusive) : (arg("end") ? utc(arg("end")!) : today);
  const symbol = arg("symbol") ?? "BTC/USD";
  const outDir = arg("out-dir") ?? "../../docs/agents";
  const name = arg("name") ?? `swing-v2-${isIS ? "in-sample" : "out-of-sample"}`;

  const { rows: pairs } = await pool.query<{ id: string; taker_fee_bps: number }>(
    `SELECT id, taker_fee_bps FROM trading_pairs WHERE symbol = $1`, [symbol],
  );
  const pair = pairs[0];
  if (!pair) throw new Error(`no trading pair ${symbol}`);
  const costs: SwingCosts = { takerFeeBps: pair.taker_fee_bps, slippageBps: SLIPPAGE_BPS };
  const stressCosts: SwingCosts = { takerFeeBps: costs.takerFeeBps * 2, slippageBps: costs.slippageBps * 2 };

  const candles: BacktestCandles = {
    h1: await loadCandles(pair.id, "1h", end),
    h4: await loadCandles(pair.id, "4h", end),
    d1: await loadCandles(pair.id, "1d", end),
    w1: await loadCandles(pair.id, "1w", end),
  };
  for (const [tf, cs] of Object.entries(candles)) {
    const last = cs[cs.length - 1];
    console.log(`[v2] ${tf}: ${cs.length} closed candles, last opens ${last ? new Date(last.time * 1000).toISOString() : "—"}`);
  }
  const series = buildSwingSeries(candles);
  const startIndex = indexAtOrAfter(candles.h4, start);
  const endIndex = candles.h4.length;
  const first = candles.h4[startIndex];
  if (!first || first.time !== start) throw new Error(`no 4h bar at the period start ${new Date(start * 1000).toISOString()}`);
  const flat = { equity: START_EQUITY, peakEquity: START_EQUITY, dayStartEquity: START_EQUITY, entriesToday: 0, killed: false, position: null, lastExitTime: null };
  if (evaluateSwingV2(snapshotAt(series, startIndex), flat, costs).reasonCode === "warmup") {
    throw new Error("v2 is still in warm-up at the period start");
  }
  console.log(`[v2] ${periodArg}: ${first ? new Date(first.time * 1000).toISOString() : ""} → ${new Date(end * 1000).toISOString()} (exclusive), ${endIndex - startIndex} 4h bars`);

  const v2Run = (c: SwingCosts): V2ReportRun & { fallbackBars: number } => {
    const r = runSwingV2({ candles, costs: c, startEquity: START_EQUITY, startIndex, endIndex, series });
    return {
      stats: { ...summarize(r.sim, START_EQUITY), haltedAt: r.sim.haltedAt, skippedDrift: r.sim.skippedDrift },
      trades: r.trades,
      decisions: r.sim.decisions,
      room: r.room,
      fallbackBars: r.sim.fallbackBars,
    };
  };
  const baseline = (kind: BaselineKind, c: SwingCosts): BaselineReportRun => {
    const r = runBaseline({ kind, h4: candles.h4, h1: candles.h1, w1: candles.w1, costs: c, startIndex, endIndex, startEquity: START_EQUITY });
    return { stats: summarize(r, START_EQUITY), trades: r.trades };
  };
  const v2 = { base: v2Run(costs), stress: v2Run(stressCosts) };
  const baselineA = { base: baseline("a", costs), stress: baseline("a", stressCosts) };
  const baselineB = { base: baseline("b", costs), stress: baseline("b", stressCosts) };

  const h4Gaps = gaps(candles.h4, TF_SEC["4h"]);
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const input = {
    period: isIS ? "in-sample" as const : "out-of-sample" as const,
    generatedAt: new Date().toISOString().slice(0, 10),
    symbol: symbol.replace("/", "-"),
    source: "Coinbase",
    dataStart: candles.h4[0]!.time,
    dataEnd: end,
    testStart: start,
    testEnd: end - 86_400,
    bars4h: endIndex - startIndex,
    gaps: { h1: gaps(candles.h1, TF_SEC["1h"]).length, h4: h4Gaps.length, list: h4Gaps.map((g) => `${fmt(g.from)} UTC, ${g.missing} × 4h missing`) },
    fallbackBars: v2.base.fallbackBars,
    costs,
    regimeShare: regimeShare(candles, startIndex, endIndex),
    v2, baselineA, baselineB,
    buyAndHold: buyAndHold(candles.h4, startIndex, costs, START_EQUITY, endIndex),
  };
  const md = renderReportV2(input);
  console.log(`[v2] verdict: ${verdictV2(input).verdict}; v2 base ${v2.base.trades.length} trades, stress ${v2.stress.trades.length}; baseline (b) ${baselineB.base.trades.length}, (a) ${baselineA.base.trades.length}`);

  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `${name}.md`);
  const csvPath = join(outDir, `${name}-trades.csv`);
  writeFileSync(mdPath, md);
  writeFileSync(csvPath, renderV2TradesCsv([
    { strategy: "v2", run: "base", trades: v2.base.trades },
    { strategy: "v2", run: "stress", trades: v2.stress.trades },
    { strategy: "baseline_b", run: "base", trades: baselineB.base.trades },
    { strategy: "baseline_b", run: "stress", trades: baselineB.stress.trades },
    { strategy: "baseline_a", run: "base", trades: baselineA.base.trades },
    { strategy: "baseline_a", run: "stress", trades: baselineA.stress.trades },
  ]));
  console.log(`[v2] wrote ${mdPath} and ${csvPath}`);
}

main()
  .catch((err) => {
    console.error("[v2] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
