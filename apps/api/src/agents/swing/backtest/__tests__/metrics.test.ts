import { describe, it, expect } from "vitest";
import type { Candle } from "../../../../indicators/shared";
import { buyAndHold, LOW_CONFIDENCE_TRADES, maxDrawdownPct, summarize, tradeStats } from "../metrics";
import type { SimResult, SimTrade } from "../simulate";

const DAY = 86_400;
const Y2024 = Date.UTC(2024, 0, 1) / 1000;

function trade(pnlUsd: number, rMultiple: number, entryTime = Y2024): SimTrade {
  return {
    side: "long", decisionTime: entryTime, entryTime, entryPrice: 100, qty: 1, stop: 98, target: 104,
    plannedR: 2, riskUsd: 2, exitTime: entryTime + DAY, exitPrice: 100 + pnlUsd, exitReason: pnlUsd > 0 ? "target" : "stop",
    feesUsd: 0.1, pnlUsd, rMultiple, barsHeld: 6, stopSource: "atr", targetSource: "2R", adx: 30,
  };
}

describe("tradeStats", () => {
  it("win rate, average R, expectancy, profit factor, losing streak", () => {
    const trades = [trade(200, 2), trade(-100, -1), trade(-100, -1), trade(-100, -1), trade(300, 3), trade(-50, -0.5)];
    const st = tradeStats(trades);
    expect(st.trades).toBe(6);
    expect(st.wins).toBe(2);
    expect(st.winRate).toBeCloseTo(2 / 6, 12);
    expect(st.avgR).toBeCloseTo(1.5 / 6, 12);
    expect(st.expectancyUsd).toBeCloseTo(150 / 6, 12);
    expect(st.netPnlUsd).toBe(150);
    expect(st.profitFactor).toBeCloseTo(500 / 350, 12);
    expect(st.longestLosingStreak).toBe(3);
    expect(st.lowConfidence).toBe(true);
  });

  it("no losers → profit factor null (∞), no trades → zeros, 30 trades is not low confidence", () => {
    expect(tradeStats([trade(10, 1)]).profitFactor).toBeNull();
    const none = tradeStats([]);
    expect(none.trades).toBe(0);
    expect(none.winRate).toBe(0);
    expect(none.lowConfidence).toBe(true);
    expect(LOW_CONFIDENCE_TRADES).toBe(30);
    expect(tradeStats(Array.from({ length: 30 }, () => trade(1, 0.1))).lowConfidence).toBe(false);
    expect(tradeStats(Array.from({ length: 29 }, () => trade(1, 0.1))).lowConfidence).toBe(true);
  });
});

describe("maxDrawdownPct", () => {
  it("largest peak-to-trough fall", () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBeCloseTo(0.25, 12);
    expect(maxDrawdownPct([100, 110, 120])).toBe(0);
    expect(maxDrawdownPct([])).toBe(0);
  });
});

describe("summarize", () => {
  it("adds return, CAGR, drawdown and time in market from the run", () => {
    const sim: SimResult = {
      trades: [trade(10_000, 2)],
      equity: [
        { time: Y2024, equity: 100_000 },
        { time: Y2024 + 182.625 * DAY, equity: 90_000 },
        { time: Y2024 + 365.25 * DAY, equity: 110_000 },
      ],
      barsTotal: 100, barsInMarket: 25, skippedDrift: 0, fallbackBars: 0, haltedAt: null, reasonCounts: {}, decisions: [],
    };
    const st = summarize(sim, 100_000);
    expect(st.returnPct).toBeCloseTo(0.1, 12);
    expect(st.cagrPct).toBeCloseTo(0.1, 6);
    expect(st.maxDrawdownPct).toBeCloseTo(0.1, 12);
    expect(st.timeInMarketPct).toBe(0.25);
    expect(st.trades).toBe(1);
  });
});

describe("buyAndHold", () => {
  it("buys the first bar's open, sells the last close, one fee + slippage each way", () => {
    const bar = (time: number, open: number, close: number, low = Math.min(open, close)): Candle =>
      ({ time, open, high: Math.max(open, close), low, close, volume: 1 });
    const h4 = [bar(Y2024, 100, 100), bar(Y2024 + 14_400, 100, 80, 70), bar(Y2024 + 28_800, 80, 120)];
    const bh = buyAndHold(h4, 0, { takerFeeBps: 5, slippageBps: 5 }, 100_000);
    const qty = 100_000 / (100 * 1.0005 * 1.0005);
    const end = qty * 120 * 0.9995 * 0.9995;
    expect(bh.returnPct).toBeCloseTo(end / 100_000 - 1, 9);
    // Marked at closes: peak 100,000-ish at bar 0, trough at bar 1's close (80).
    expect(bh.maxDrawdownPct).toBeCloseTo(1 - (qty * 80) / (qty * 100), 6);
  });
});
