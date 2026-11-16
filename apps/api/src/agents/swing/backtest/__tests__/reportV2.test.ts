/**
 * The v2 verdict against the pass bar fixed 2026-11-15, and the report's
 * shape: verdict in the first lines, a plain "baseline beats v2" line, and
 * every table split into all / long / short.
 */
import { describe, it, expect } from "vitest";
import { tradeStats, type RunStats } from "../metrics";
import { renderReportV2, renderV2TradesCsv, verdictV2, type V2ReportInput } from "../reportV2";
import type { BacktestTrade } from "../runSwingBacktest";

const Y = (y: number) => Date.UTC(y, 0, 1) / 1000;

function trade(side: "long" | "short", r: number, year = 2020): BacktestTrade {
  return {
    side, decisionTime: Y(year), entryTime: Y(year) + 14_400, entryPrice: 100, qty: 1, stop: 98, target: null, plannedR: 2, riskUsd: 1_000,
    exitTime: Y(year) + 86_400, exitPrice: 100 + 2 * r, exitReason: r < 0 ? "stop" : "trend", feesUsd: 1, pnlUsd: 1_000 * r, rMultiple: r,
    barsHeld: 6, stopSource: "atr", targetSource: null, adx: 25, regime: "trending",
  };
}

function stats(trades: BacktestTrade[], over: Partial<RunStats> = {}): RunStats & { haltedAt: null; skippedDrift: number } {
  return { ...tradeStats(trades), returnPct: 0.1, cagrPct: 0.05, maxDrawdownPct: 0.1, timeInMarketPct: 0.2, mar: 0.5, haltedAt: null, skippedDrift: 0, ...over };
}

function input(o: { n: number; r: number; stressR?: number; mar?: number; marB?: number; dd?: number; period?: "in-sample" | "out-of-sample" }): V2ReportInput {
  const trades = Array.from({ length: o.n }, (_, i) => trade(i % 2 ? "short" : "long", o.r));
  const stressTrades = trades.map((t) => ({ ...t, rMultiple: o.stressR ?? o.r, pnlUsd: 1_000 * (o.stressR ?? o.r) }));
  const run = (ts: BacktestTrade[], over: Partial<RunStats> = {}) => ({
    stats: stats(ts, over), trades: ts, decisions: [{ reasonCode: "no_setup", side: "long" as const }, { reasonCode: "entry", side: "short" as const }],
    room: [{ side: "long" as const, roomR: 0.4 }, { side: "short" as const, roomR: "none" as const }, { side: "long" as const, roomR: 1.5 }],
  });
  const bStats = { ...tradeStats([]), returnPct: 0.05, cagrPct: 0.02, maxDrawdownPct: 0.05, timeInMarketPct: 0.5, mar: o.marB ?? 0.4 };
  return {
    period: o.period ?? "in-sample",
    generatedAt: "2026-11-15", symbol: "BTC-USD", source: "Coinbase",
    dataStart: Y(2015), dataEnd: Y(2024), testStart: Y(2019), testEnd: Y(2024) - 86_400, bars4h: 10_000,
    gaps: { h1: 1, h4: 0, list: [] }, fallbackBars: 0, costs: { takerFeeBps: 5, slippageBps: 5 },
    regimeShare: { trending: 0.5, transitional: 0.25, ranging: 0.25, unknown: 0 },
    v2: { base: run(trades, { mar: o.mar ?? 0.5, maxDrawdownPct: o.dd ?? 0.1 }), stress: run(stressTrades) },
    baselineA: { base: { stats: { ...bStats, mar: 0.3 }, trades: [] }, stress: { stats: bStats, trades: [] } },
    baselineB: { base: { stats: bStats, trades: [] }, stress: { stats: bStats, trades: [] } },
    buyAndHold: { returnPct: 3, cagrPct: 0.4, maxDrawdownPct: 0.77, mar: 0.52 },
  };
}

describe("verdictV2", () => {
  it("in-sample: fewer than 30 trades is INCONCLUSIVE even if the rest passes", () => {
    expect(verdictV2(input({ n: 29, r: 1 })).verdict).toBe("INCONCLUSIVE");
  });
  it("in-sample: PASS needs >= 30 trades, stress expectancy > 0R and MAR >= baseline (b)", () => {
    expect(verdictV2(input({ n: 30, r: 1 })).verdict).toBe("PASS");
    expect(verdictV2(input({ n: 30, r: 1, mar: 0.4, marB: 0.4 })).verdict).toBe("PASS");
  });
  it("in-sample: FAIL on stress expectancy <= 0R or MAR under baseline (b)", () => {
    expect(verdictV2(input({ n: 40, r: 1, stressR: 0 })).verdict).toBe("FAIL");
    expect(verdictV2(input({ n: 40, r: 1, mar: 0.39, marB: 0.4 })).verdict).toBe("FAIL");
  });
  it("out-of-sample: expectancy > 0R, max DD <= 20%, MAR >= 75% of baseline (b)", () => {
    expect(verdictV2(input({ period: "out-of-sample", n: 10, r: 0.5, mar: 0.3, marB: 0.4, dd: 0.2 })).verdict).toBe("PASS");
    expect(verdictV2(input({ period: "out-of-sample", n: 10, r: 0.5, mar: 0.29, marB: 0.4 })).verdict).toBe("FAIL");
    expect(verdictV2(input({ period: "out-of-sample", n: 10, r: 0.5, dd: 0.21 })).verdict).toBe("FAIL");
    expect(verdictV2(input({ period: "out-of-sample", n: 10, r: 0 })).verdict).toBe("FAIL");
  });
  it("out-of-sample with a negative baseline MAR: within 25% means >= marB − 0.25 × |marB|", () => {
    expect(verdictV2(input({ period: "out-of-sample", n: 10, r: 0.5, mar: -0.5, marB: -0.4 })).verdict).toBe("PASS");
    expect(verdictV2(input({ period: "out-of-sample", n: 10, r: 0.5, mar: -0.51, marB: -0.4 })).verdict).toBe("FAIL");
  });
});

describe("renderReportV2", () => {
  it("puts the verdict in the first lines and says plainly when a baseline beats v2", () => {
    const md = renderReportV2(input({ n: 10, r: 1, mar: 0.35 }));
    const head = md.split("\n").slice(0, 12).join("\n");
    expect(head).toContain("**Verdict: INCONCLUSIVE**");
    expect(head).toContain("Only 10 trades (needs 30)");
    expect(md).toContain("**A baseline beats v2 on MAR");
    expect(md).toContain("buy and hold 0.52");
    expect(md).toContain("out-of-sample is **not** run");
  });

  it("says in the first lines when the drawdown halt tripped and how much of the period it blocked", () => {
    const r = input({ n: 10, r: 1 });
    r.v2.base.stats = { ...r.v2.base.stats, haltedAt: Date.UTC(2020, 3, 14) / 1000 } as typeof r.v2.base.stats;
    r.v2.base.decisions = [{ reasonCode: "killed", side: "long" }, { reasonCode: "killed", side: "short" }, { reasonCode: "entry", side: "long" }, { reasonCode: "no_setup", side: "long" }];
    const head = renderReportV2(r).split("\n").slice(0, 14).join("\n");
    expect(head).toContain("**The 15% drawdown halt tripped on 2020-04-14 (base run)**");
    expect(head).toContain("50.00% of the period's evaluations were blocked by it");
    expect(renderReportV2(input({ n: 10, r: 1 }))).not.toContain("drawdown halt tripped on");
  });

  it("splits summary and group tables into all / long / short and flags low confidence", () => {
    const md = renderReportV2(input({ n: 10, r: 1 }));
    expect(md).toMatch(/\| v2 \(Variant A\) \| base \| long \| 5 \|/);
    expect(md).toMatch(/\| v2 \(Variant A\) \| base \| short \| 5 \|/);
    expect(md).toContain("short (long only)");
    expect(md).toMatch(/\| 2020 \| long \| 5 \|/);
    expect(md).toContain("⚠ low confidence (n=10)");
    expect(md).toMatch(/\| `entry` \| entered a trade \| 0 \| 1 \| 0 \| 1 \|/);
  });

  it("room table: median and pass share per side ('none' passes)", () => {
    const md = renderReportV2(input({ n: 10, r: 1 }));
    expect(md).toMatch(/\| all \| 3 \| 1 \| 0\.68R \| 0\.95R \| 1\.23R \| 66\.67% \|/);
    expect(md).toMatch(/\| long \| 2 \| 0 \|/);
  });

  it("CSV carries strategy and run per trade", () => {
    const csv = renderV2TradesCsv([{ strategy: "v2", run: "base", trades: [trade("long", 1)] }]);
    expect(csv.split("\n")[1]).toMatch(/^v2,base,long,/);
  });
});
