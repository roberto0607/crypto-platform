/**
 * The order panel's liq price and health bar run the server's margin cases,
 * so what the user sees before submit is what the engine computes.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js-light";
import {
  bankruptcyPrice,
  isLiquidatable,
  isValidLeverage,
  liquidationPrice,
  maintenanceMargin,
  marginHealth,
  notional,
  positionEquity,
  releasedMargin,
  settleReduce,
  sizeForMargin,
  unrealizedPnl,
  type MarginPosition,
} from "@/lib/margin";
// A copy of the API's case table: the web Docker build only sees apps/web.
// The API test fails if the two copies differ.
import cases from "./marginCases.json";

const d = (v: string) => new Decimal(v);
const r8 = (x: Decimal) => x.toFixed(8, Decimal.ROUND_HALF_UP);

function pos(c: (typeof cases.positions)[number]): MarginPosition {
  return { side: c.side as "LONG" | "SHORT", qty: d(c.qty), entry: d(c.entry), margin: d(c.margin), mmrBps: c.mmrBps };
}

describe("margin (shared with the API)", () => {
  it("design doc worked example: liq $75,075.38 long, $90,845.77 short", () => {
    expect(liquidationPrice(pos(cases.positions[0]!)).toFixed(2, Decimal.ROUND_HALF_UP)).toBe("75075.38");
    expect(liquidationPrice(pos(cases.positions[1]!)).toFixed(2, Decimal.ROUND_HALF_UP)).toBe("90845.77");
  });

  describe.each(cases.positions)("$name", (c) => {
    const p = pos(c);

    it("notional, liq price, bankruptcy price", () => {
      expect(r8(notional(p.qty, p.entry))).toBe(c.expected.notional);
      expect(r8(liquidationPrice(p))).toBe(c.expected.liq);
      expect(r8(bankruptcyPrice(p))).toBe(c.expected.bankruptcy);
    });

    it.each(c.marks)("at mark $mark", (m) => {
      const mark = d(m.mark);
      const u = unrealizedPnl(p.side, p.qty, p.entry, mark);
      expect(r8(u)).toBe(m.upnl);
      expect(r8(positionEquity(p.margin, u))).toBe(m.equity);
      expect(r8(maintenanceMargin(p.qty, mark, p.mmrBps))).toBe(m.maintenance);
      expect(isLiquidatable(p, mark)).toBe(m.liquidatable);
      expect(r8(marginHealth(p, mark))).toBe(m.health);
    });
  });

  it.each(cases.reduces)("settle: $name", (c) => {
    const s = settleReduce(d(c.released), d(c.pnl), d(c.fee));
    expect({
      credit: r8(s.credit),
      bookedPnl: r8(s.bookedPnl),
      bookedFee: r8(s.bookedFee),
      uncollectedFee: r8(s.uncollectedFee),
      shortfall: r8(s.shortfall),
    }).toEqual(c.expected);
  });

  it.each(cases.sizes)("size: $margin margin @ $leverage x, price $price", (c) => {
    expect(r8(sizeForMargin(d(c.margin), d(c.leverage), d(c.price)))).toBe(c.expected);
  });

  it.each(cases.releases)("release on closing $closeQty of $posQty", (c) => {
    expect(r8(releasedMargin(d(c.margin), d(c.closeQty), d(c.posQty)))).toBe(c.expected);
  });

  it.each(cases.leverage)("$leverage x under a $cap x cap → $valid", (c) => {
    expect(isValidLeverage(c.leverage, c.cap)).toBe(c.valid);
  });
});
