/**
 * swingBacktest.ts — backtest the Swing Agent (Variant A and B) on stored
 * BTC-USD candles and write a Markdown report + a per-trade CSV.
 *
 * Usage (from apps/api, DATABASE_URL at a DB with candle history, e.g. after
 * `pnpm backfill:history --symbols BTC-USD`; never point it at production):
 *   pnpm agent:backtest                          # data through today 00:00 UTC
 *   pnpm agent:backtest --end 2026-11-15 --out-dir ../../docs/agents --name swing-backtest-2026-11
 *
 * Read-only: it only SELECTs candles and the pair's taker fee.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db/pool";
import type { Candle } from "../indicators/shared";
import { buildSwingSeries } from "../agents/swing/swingSeries";
import type { SwingCosts, SwingVariant } from "../agents/swing/evaluateSwing";
import { buyAndHold, summarize } from "../agents/swing/backtest/metrics";
import { renderReport, renderTradesCsv, type ReportRun } from "../agents/swing/backtest/report";
import {
  firstEvaluableIndex, regimeShare, runSwingBacktest, type BacktestCandles,
} from "../agents/swing/backtest/runSwingBacktest";

const SLIPPAGE_BPS = 5;
const START_EQUITY = 100_000;
const TF_SEC = { "1h": 3_600, "4h": 14_400, "1d": 86_400, "1w": 604_800 } as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

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
  const symbol = arg("symbol") ?? "BTC/USD";
  const endArg = arg("end");
  const end = endArg ? Date.parse(`${endArg}T00:00:00Z`) / 1000 : Math.floor(Date.now() / 86_400_000) * 86_400;
  const outDir = arg("out-dir") ?? "../../docs/agents";
  const name = arg("name") ?? `swing-backtest-${new Date(end * 1000).toISOString().slice(0, 10)}`;

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
  for (const [tf, cs] of Object.entries(candles)) console.log(`[backtest] ${tf}: ${cs.length} closed candles`);
  if (candles.h4.length === 0) throw new Error("no 4h candles: run pnpm backfill:history first");

  const series = buildSwingSeries(candles);
  const startIndex = firstEvaluableIndex(series);
  const h4Gaps = gaps(candles.h4, TF_SEC["4h"]);
  const h1Gaps = gaps(candles.h1, TF_SEC["1h"]);
  console.log(`[backtest] start ${new Date(candles.h4[startIndex]!.time * 1000).toISOString()} (index ${startIndex})`);

  const variants = [] as Array<{ variant: SwingVariant; base: ReportRun; adx25: ReportRun; stress: ReportRun }>;
  const csvRuns: Parameters<typeof renderTradesCsv>[0] = [];
  let fallbackBars = 0;
  for (const variant of ["A", "B"] as const) {
    const one = (c: SwingCosts, adxMin?: number): ReportRun => {
      const r = runSwingBacktest({ candles, variant, costs: c, startEquity: START_EQUITY, adxMin, series, startIndex });
      return {
        stats: { ...summarize(r.sim, START_EQUITY), haltedAt: r.sim.haltedAt, skippedDrift: r.sim.skippedDrift },
        trades: r.trades,
        reasonCounts: r.sim.reasonCounts,
      };
    };
    const base = one(costs);
    const adx25 = one(costs, 25);
    const stress = one(stressCosts);
    fallbackBars = Math.max(fallbackBars, runSwingBacktest({ candles, variant, costs, startEquity: START_EQUITY, series, startIndex }).sim.fallbackBars);
    variants.push({ variant, base, adx25, stress });
    csvRuns.push({ variant, run: "base", trades: base.trades }, { variant, run: "adx25", trades: adx25.trades }, { variant, run: "stress", trades: stress.trades });
    console.log(`[backtest] ${variant}: base ${base.trades.length} trades, ADX>=25 ${adx25.trades.length}, stress ${stress.trades.length}`);
  }

  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const md = renderReport({
    generatedAt: new Date().toISOString().slice(0, 10),
    symbol: symbol.replace("/", "-"),
    source: "Coinbase",
    dataStart: candles.h4[0]!.time,
    dataEnd: end,
    testStart: candles.h4[startIndex]!.time,
    testEnd: end,
    bars4h: candles.h4.length - startIndex,
    gaps: {
      h1: h1Gaps.length,
      h4: h4Gaps.length,
      list: h4Gaps.map((g) => `${fmt(g.from)} UTC, ${g.missing} × 4h missing`),
    },
    fallbackBars,
    costs,
    regimeShare: regimeShare(candles, startIndex),
    variants,
    buyAndHold: buyAndHold(candles.h4, startIndex, costs, START_EQUITY),
  });

  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `${name}.md`);
  const csvPath = join(outDir, `${name}-trades.csv`);
  writeFileSync(mdPath, md);
  writeFileSync(csvPath, renderTradesCsv(csvRuns));
  console.log(`[backtest] wrote ${mdPath} and ${csvPath}`);
}

main()
  .catch((err) => {
    console.error("[backtest] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
