/**
 * leverageUi: what the order panel and position card show for an ISOLATED
 * order / position, on top of lib/margin.ts (shared cases with the server).
 * Numbers are the design doc's worked example (§3): $50 at 10x long BTC at
 * $83,000, MMR 0.5%, taker 5 bps.
 */
import { describe, it, expect } from "vitest";
import {
  leverageOptions,
  orderPreview,
  maxMargin,
  isolatedPositionView,
  scopeEquity,
  healthTone,
} from "@/lib/leverageUi";

describe("leverageOptions", () => {
  it("offers only values ≤ the server's cap", () => {
    expect(leverageOptions(10)).toEqual([1, 2, 3, 5, 10]);
    expect(leverageOptions(5)).toEqual([1, 2, 3, 5]);
    expect(leverageOptions(4)).toEqual([1, 2, 3]);
    expect(leverageOptions(1)).toEqual([1]);
    expect(leverageOptions(0)).toEqual([1]);
  });
});

describe("orderPreview", () => {
  const base = { margin: 50, price: 83000, takerBps: 5, mmrBps: 50 };

  it("10x long: notional $500, size 0.00602409, fee on the notional, liq $75,075.38", () => {
    const p = orderPreview({ ...base, leverage: 10, side: "LONG" });
    expect(p.qty).toBe("0.00602409");
    expect(p.notional).toBeCloseTo(499.99947, 5);
    expect(p.fee).toBeCloseTo(0.24999973, 8);
    expect(p.liqPrice!.toFixed(2)).toBe("75075.38");
    expect(p.liqDistancePct!).toBeCloseTo(-9.55, 2);
  });

  it("10x short: liq $90,845.77", () => {
    const p = orderPreview({ ...base, leverage: 10, side: "SHORT" });
    expect(p.liqPrice!.toFixed(2)).toBe("90845.77");
    expect(p.liqDistancePct!).toBeCloseTo(9.45, 2);
  });

  it("1x long can't be liquidated: no liq price", () => {
    expect(orderPreview({ ...base, leverage: 1, side: "LONG" }).liqPrice).toBeNull();
  });

  it("nothing entered, or no price: empty", () => {
    expect(orderPreview({ ...base, margin: 0, leverage: 10, side: "LONG" })).toMatchObject({ qty: "", notional: 0, fee: 0, liqPrice: null });
    expect(orderPreview({ ...base, price: 0, leverage: 10, side: "LONG" })).toMatchObject({ qty: "", notional: 0, liqPrice: null });
  });
});

describe("maxMargin", () => {
  it("leaves room for the fee on the notional, floored to the cent", () => {
    // 1000 / (1 + 10 × 0.0005) = 995.024…
    expect(maxMargin(1000, 10, 5)).toBe(995.02);
    expect(maxMargin(1000, 1, 5)).toBe(999.5);
    expect(maxMargin(0, 10, 5)).toBe(0);
    expect(maxMargin(-5, 10, 5)).toBe(0);
  });
});

describe("isolatedPositionView", () => {
  const pos = { baseQty: "0.00602409", entry: "83000", margin: "49.99994700", leverage: "10.00", liqPrice: "75075.37688442", mmrBps: 50 };

  it("at entry: uPnL 0, ROE 0, health 100%", () => {
    const v = isolatedPositionView({ ...pos, mark: 83000 });
    expect(v.side).toBe("LONG");
    expect(v.leverage).toBe(10);
    expect(v.notional).toBeCloseTo(499.99947, 5);
    expect(v.unrealizedPnl).toBeCloseTo(0, 8);
    expect(v.roePct).toBeCloseTo(0, 6);
    expect(v.health).toBeCloseTo(1, 6);
    expect(v.liqPrice).toBe(75075.37688442);
  });

  it("at $80,000: uPnL −$18.07, ROE −36.1% of margin", () => {
    const v = isolatedPositionView({ ...pos, mark: 80000 });
    expect(v.unrealizedPnl).toBeCloseTo(-18.07227, 4);
    expect(v.roePct).toBeCloseTo(-36.14, 2);
    expect(v.health).toBeGreaterThan(0);
    expect(v.health).toBeLessThan(1);
  });

  it("past bankruptcy: the loss is capped at the margin (−100% ROE), health 0", () => {
    const v = isolatedPositionView({ ...pos, mark: 74000 });
    expect(v.unrealizedPnl).toBeCloseTo(-49.999947, 6);
    expect(v.roePct).toBeCloseTo(-100, 6);
    expect(v.health).toBe(0);
  });

  it("a short gains as price falls", () => {
    const v = isolatedPositionView({ ...pos, baseQty: "-0.00602409", liqPrice: "90845.77114427", mark: 82000 });
    expect(v.side).toBe("SHORT");
    expect(v.unrealizedPnl).toBeCloseTo(6.02409, 5);
  });
});

describe("scopeEquity", () => {
  it("USD + ISOLATED margin + capped uPnL; SPOT rows at base × mark", () => {
    const marks: Record<string, number> = { btc: 80000, eth: 3000 };
    const eq = scopeEquity(1000, [
      { pair_id: "btc", base_qty: "0.00602409", avg_entry_price: "83000", margin_mode: "ISOLATED", isolated_margin: "49.99994700" },
      { pair_id: "eth", base_qty: "1", avg_entry_price: "2900", margin_mode: undefined, isolated_margin: undefined },
    ], (id) => marks[id] ?? null);
    // 1000 + (49.999947 − 18.072270) + 3000
    expect(eq).toBeCloseTo(4031.927677, 5);
  });

  it("an ISOLATED position past bankruptcy counts 0, never negative", () => {
    const eq = scopeEquity(100, [
      { pair_id: "btc", base_qty: "0.00602409", avg_entry_price: "83000", margin_mode: "ISOLATED", isolated_margin: "49.99994700" },
    ], () => 60000);
    expect(eq).toBeCloseTo(100, 8);
  });

  it("a position whose pair has no mark yet: unknown (null)", () => {
    expect(scopeEquity(100, [{ pair_id: "x", base_qty: "1", avg_entry_price: "1", margin_mode: "ISOLATED", isolated_margin: "1" }], () => null)).toBeNull();
  });
});

describe("healthTone", () => {
  it("green above 50%, amber 25–50%, red below 25%", () => {
    expect(healthTone(0.8)).toBe("ok");
    expect(healthTone(0.5)).toBe("warn");
    expect(healthTone(0.3)).toBe("warn");
    expect(healthTone(0.24)).toBe("danger");
    expect(healthTone(0)).toBe("danger");
  });
});
