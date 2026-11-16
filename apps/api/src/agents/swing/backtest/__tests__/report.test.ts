import { describe, it, expect } from "vitest";
import { renderReport, renderTradesCsv, type ReportInput } from "../report";
import type { BacktestTrade } from "../runSwingBacktest";
import { tradeStats } from "../metrics";

const Y = (y: number) => Date.UTC(y, 2, 1) / 1000;

function t(pnlUsd: number, year: number, regime: BacktestTrade["regime"]): BacktestTrade {
  return {
    side: "long", decisionTime: Y(year), entryTime: Y(year), entryPrice: 100, qty: 1, stop: 98, target: 104,
    plannedR: 2, riskUsd: 2, exitTime: Y(year) + 86_400, exitPrice: 100 + pnlUsd, exitReason: pnlUsd > 0 ? "target" : "stop",
    feesUsd: 0.1, pnlUsd, rMultiple: pnlUsd / 2, barsHeld: 6, stopSource: "atr", targetSource: "2R", adx: 30, regime,
  };
}

function input(trades: BacktestTrade[]): ReportInput {
  const stats = { ...tradeStats(trades), returnPct: 0.05, cagrPct: 0.02, maxDrawdownPct: 0.08, timeInMarketPct: 0.1, haltedAt: null, skippedDrift: 0 };
  const run = { stats, trades, reasonCounts: { entry: trades.length, bias_neutral: 10 } };
  return {
    generatedAt: "2026-11-15",
    symbol: "BTC-USD",
    source: "Coinbase",
    dataStart: Y(2019), dataEnd: Y(2026), testStart: Y(2019), testEnd: Y(2026),
    bars4h: 1000, gaps: { h1: 2, h4: 1, list: ["2020-01-01 04:00 (4h)"] }, fallbackBars: 3,
    costs: { takerFeeBps: 5, slippageBps: 5 },
    regimeShare: { trending: 0.4, transitional: 0.3, ranging: 0.3, unknown: 0 },
    variants: [
      { variant: "A", base: run, adx25: run, stress: run },
      { variant: "B", base: run, adx25: run, stress: run },
    ],
    buyAndHold: { returnPct: 3, cagrPct: 0.3, maxDrawdownPct: 0.77 },
  };
}

describe("report", () => {
  const trades = [t(10, 2020, "trending"), t(-5, 2020, "ranging"), t(8, 2021, "trending")];
  const md = renderReport(input(trades));

  it("has every section the plan promised", () => {
    for (const heading of [
      "## Summary", "## Variant A", "## Variant B", "### By year", "### By regime", "### Exit reasons",
      "### Why it did nothing", "## Buy and hold", "## Method",
    ]) expect(md).toContain(heading);
    expect(md).toMatch(/ADX ≥ 25/);
    expect(md).toMatch(/fees \+ slippage ×2/);
  });

  it("states trade counts and flags anything under 30 trades as low confidence", () => {
    expect(md).toContain("| A | base | 3 |");
    expect(md).toContain("⚠ low confidence");
    expect(md).toMatch(/fewer than 30 trades/);
  });

  it("CSV: one row per trade with the agreed columns", () => {
    const csv = renderTradesCsv([{ variant: "A", run: "base", trades }]).trim().split("\n");
    expect(csv[0]).toBe(
      "variant,run,side,entry_time,exit_time,entry_price,exit_price,stop,target,qty,r_multiple,pnl_usd,fees_usd,exit_reason,bars_held,stop_source,target_source,adx_4h,regime",
    );
    expect(csv).toHaveLength(4);
    expect(csv[1]).toMatch(/^A,base,long,2020-03-01T00:00:00Z,2020-03-02T00:00:00Z,100,110,98,104,1,5,10,0.1,target,6,atr,2R,30,trending$/);
  });
});
