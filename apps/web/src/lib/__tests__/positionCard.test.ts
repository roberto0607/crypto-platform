import { describe, it, expect } from "vitest";
import {
  breakEvenPrice,
  liqDistancePct,
  openDuration,
  equityAtLiq,
  isAtRisk,
  addPreview,
  reverseSummary,
} from "@/lib/positionCard";

describe("breakEvenPrice: closing at it (taker fee f) nets the fees paid back to 0", () => {
  it("short 0.0616523 @ 81,100, $2.50 paid, f 5 bps → $81,018.94", () => {
    const be = breakEvenPrice({ side: "SHORT", qty: 0.0616523, entry: 81100, feesPaid: 2.5, takerBps: 5 })!;
    expect(be.toFixed(2)).toBe("81018.94");
  });

  it("long: (E·Q + F) / (Q·(1 − f))", () => {
    const be = breakEvenPrice({ side: "LONG", qty: 0.0616523, entry: 81100, feesPaid: 2.5, takerBps: 5 })!;
    expect(be.toFixed(2)).toBe("81181.14");
  });

  it("closing at it really nets 0: long and short", () => {
    for (const side of ["LONG", "SHORT"] as const) {
      const p = { side, qty: 0.5, entry: 3000, feesPaid: 1.2, takerBps: 10 };
      const be = breakEvenPrice(p)!;
      const pnl = (side === "LONG" ? be - p.entry : p.entry - be) * p.qty;
      const closeFee = be * p.qty * 0.001;
      expect(pnl - closeFee - p.feesPaid).toBeCloseTo(0, 9);
    }
  });

  it("uses the pair's fee, not a constant", () => {
    const a = breakEvenPrice({ side: "LONG", qty: 1, entry: 100, feesPaid: 0, takerBps: 5 })!;
    const b = breakEvenPrice({ side: "LONG", qty: 1, entry: 100, feesPaid: 0, takerBps: 20 })!;
    expect(b).toBeGreaterThan(a);
  });

  it("null without a size", () => {
    expect(breakEvenPrice({ side: "LONG", qty: 0, entry: 100, feesPaid: 0, takerBps: 5 })).toBeNull();
  });
});

describe("liqDistancePct: how far the mark can move before liquidation", () => {
  it("long: (mark − liq) / mark", () => {
    expect(liqDistancePct("LONG", 80000, 75075.38)).toBeCloseTo(6.1558, 3);
  });
  it("short: (liq − mark) / mark", () => {
    expect(liqDistancePct("SHORT", 40000, 84080)).toBeCloseTo(110.2, 6);
  });
  it("no liq price (a 1x long): null", () => {
    expect(liqDistancePct("LONG", 80000, null)).toBeNull();
  });
  it("past the liq price: 0, never negative", () => {
    expect(liqDistancePct("LONG", 70000, 75000)).toBe(0);
  });
});

describe("openDuration", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  it.each([
    ["2026-10-30T08:00:00Z", "3d 4h"],
    ["2026-11-02T07:48:00Z", "4h 12m"],
    ["2026-11-02T11:48:30Z", "11m"],
    ["2026-11-02T11:59:40Z", "<1m"],
    ["2026-11-02T12:00:05Z", "<1m"], // a little clock skew
  ])("%s → %s", (at, want) => {
    expect(openDuration(at, now)).toBe(want);
  });
  it("null / unparseable: null (hidden)", () => {
    expect(openDuration(null, now)).toBeNull();
    expect(openDuration(undefined, now)).toBeNull();
    expect(openDuration("nope", now)).toBeNull();
  });
});

describe("equityAtLiq: what's left at the liq price ≈ the maintenance margin", () => {
  it("Q · liq · mmr", () => {
    expect(equityAtLiq(0.0616523, 84080, 50)).toBeCloseTo(25.9186, 4);
  });
  it("null without a liq price", () => {
    expect(equityAtLiq(1, null, 50)).toBeNull();
  });
});

describe("isAtRisk: health below 25% (the red band)", () => {
  it.each([[0.2499, true], [0.25, false], [0.9, false], [0, true]])("%d → %s", (h, want) => {
    expect(isAtRisk(h, 80000)).toBe(want);
  });
  it("never without a liq price", () => {
    expect(isAtRisk(0, null)).toBe(false);
  });
});

describe("addPreview: the position's liq price after an add (engine math)", () => {
  it("the doc long + the same size at 85,000 → $75,979.90", () => {
    const r = addPreview(
      { baseQty: "0.00602409", entry: "83000", margin: "49.99994700", leverage: "10", mmrBps: 50 },
      "0.00602409", 85000,
    )!;
    expect(r.liqPrice!.toFixed(2)).toBe("75979.90");
    expect(r.qty).toBeCloseTo(0.01204818, 8);
    expect(r.entry).toBe(84000);
  });
  it("a short", () => {
    const r = addPreview(
      { baseQty: "-0.06500000", entry: "76673.9", margin: "498.38035", leverage: "10", mmrBps: 50 },
      "0.01000000", 77000,
    )!;
    expect(r.liqPrice!.toFixed(8)).toBe("83969.27164179");
  });
  it("a 1x long stays unliquidatable: null", () => {
    const r = addPreview(
      { baseQty: "0.01", entry: "83000", margin: "830", leverage: "1", mmrBps: 50 },
      "0.01", 80000,
    )!;
    expect(r.liqPrice).toBeNull();
  });
  it("nothing to add: null", () => {
    expect(addPreview({ baseQty: "0.01", entry: "83000", margin: "830", leverage: "1", mmrBps: 50 }, "", 80000)).toBeNull();
  });
});

describe("reverseSummary: what a CLOSE & REVERSE order does to the position", () => {
  it("bigger than the position: closes it and opens the other side with the rest", () => {
    expect(reverseSummary({ positionSide: "SHORT", positionQty: 0.065, orderQty: 0.1 }))
      .toEqual({ kind: "flip", openSide: "LONG", openQty: 0.035 });
  });
  it("the same size: closes it, opens nothing", () => {
    expect(reverseSummary({ positionSide: "LONG", positionQty: 0.065, orderQty: 0.065 }))
      .toEqual({ kind: "close", openSide: "SHORT", openQty: 0 });
  });
  it("smaller: only reduces it", () => {
    expect(reverseSummary({ positionSide: "LONG", positionQty: 0.065, orderQty: 0.02 }))
      .toEqual({ kind: "reduce", openSide: "SHORT", openQty: 0 });
  });
});
