/**
 * margin.test.ts — the isolated-margin math (trading/margin.ts) on the shared
 * marginCases.json, which the web copy (apps/web/src/lib/margin.ts) runs too.
 * The cases come from an independent Decimal oracle of the design doc's §3;
 * the doc's worked-example numbers are also asserted directly below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Decimal from "decimal.js";
import { D } from "../../utils/decimal";
import {
    bankruptcyPrice,
    initialMargin,
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
} from "../margin";
import cases from "./marginCases.json";

/** Half-up to 8 dp: how the cases are written (the API default rounding is DOWN). */
const r8 = (d: Decimal) => d.toFixed(8, Decimal.ROUND_HALF_UP);
/** Half-up to cents: how a price is shown. */
const r2 = (d: Decimal) => d.toFixed(2, Decimal.ROUND_HALF_UP);

function pos(c: (typeof cases.positions)[number]): MarginPosition {
    return { side: c.side as "LONG" | "SHORT", qty: D(c.qty), entry: D(c.entry), margin: D(c.margin), mmrBps: c.mmrBps };
}

describe("design doc worked example (§3)", () => {
    const long = pos(cases.positions[0]!);
    const short = pos(cases.positions[1]!);

    it("$50 @ 10x long BTC @ 83,000 → $500 notional, liq $75,075.38, bankruptcy $74,700", () => {
        expect(r2(notional(long.qty, long.entry))).toBe("500.00");
        expect(r2(liquidationPrice(long))).toBe("75075.38");
        expect(r2(bankruptcyPrice(long))).toBe("74700.00");
    });

    it("$50 @ 10x short BTC @ 83,000 → liq $90,845.77, bankruptcy $91,300", () => {
        expect(r2(liquidationPrice(short))).toBe("90845.77");
        expect(r2(bankruptcyPrice(short))).toBe("91300.00");
    });

    it("at the liq price, equity equals maintenance margin", () => {
        const liq = liquidationPrice(long);
        const equity = long.margin.plus(unrealizedPnl("LONG", long.qty, long.entry, liq));
        expect(r8(equity)).toBe(r8(maintenanceMargin(long.qty, liq, long.mmrBps)));
        expect(isLiquidatable(long, liq)).toBe(true);
        expect(isLiquidatable(long, liq.plus("0.01"))).toBe(false);
    });

    it("a gap to $74,000 loses the margin and no more: $4.22 shortfall absorbed", () => {
        const pnl = unrealizedPnl("LONG", long.qty, long.entry, D("74000"));
        const s = settleReduce(long.margin, pnl, D("0.22"));
        expect(r8(s.credit)).toBe("0.00000000");
        expect(r8(s.bookedPnl)).toBe(r8(long.margin.neg()));
        expect(r2(s.shortfall)).toBe("4.22");
    });

    it("initial margin is notional / leverage", () => {
        expect(r8(initialMargin(D("500"), D("10")))).toBe("50.00000000");
    });
});

describe("positions (shared cases)", () => {
    describe.each(cases.positions)("$name", (c) => {
        const p = pos(c);

        it("notional, liq price, bankruptcy price", () => {
            expect(r8(notional(p.qty, p.entry))).toBe(c.expected.notional);
            expect(r8(liquidationPrice(p))).toBe(c.expected.liq);
            expect(r8(bankruptcyPrice(p))).toBe(c.expected.bankruptcy);
        });

        it.each(c.marks)("at mark $mark", (m) => {
            const mark = D(m.mark);
            const u = unrealizedPnl(p.side, p.qty, p.entry, mark);
            expect(r8(u)).toBe(m.upnl);
            expect(r8(positionEquity(p.margin, u))).toBe(m.equity);
            expect(r8(maintenanceMargin(p.qty, mark, p.mmrBps))).toBe(m.maintenance);
            expect(isLiquidatable(p, mark)).toBe(m.liquidatable);
            expect(r8(marginHealth(p, mark))).toBe(m.health);
        });
    });

    it("a position built from margin locks no more than the margin entered", () => {
        for (const c of cases.positions.filter((x) => "fromMargin" in x)) {
            expect(D(c.margin).lte(D((c as { fromMargin: string }).fromMargin))).toBe(true);
        }
    });
});

describe("settleReduce (shared cases)", () => {
    it.each(cases.reduces)("$name", (c) => {
        const s = settleReduce(D(c.released), D(c.pnl), D(c.fee));
        expect({
            credit: r8(s.credit),
            bookedPnl: r8(s.bookedPnl),
            bookedFee: r8(s.bookedFee),
            uncollectedFee: r8(s.uncollectedFee),
            shortfall: r8(s.shortfall),
        }).toEqual(c.expected);
        // The identity the engine relies on: credit = released + bookedPnl − bookedFee, never < 0.
        expect(r8(s.credit)).toBe(r8(D(c.released).plus(s.bookedPnl).minus(s.bookedFee)));
        expect(s.credit.gte(0)).toBe(true);
    });
});

describe("sizeForMargin / releasedMargin / isValidLeverage (shared cases)", () => {
    it.each(cases.sizes)("$margin margin @ $leverage x, price $price", (c) => {
        expect(r8(sizeForMargin(D(c.margin), D(c.leverage), D(c.price)))).toBe(c.expected);
    });

    it.each(cases.releases)("release on closing $closeQty of $posQty", (c) => {
        expect(r8(releasedMargin(D(c.margin), D(c.closeQty), D(c.posQty)))).toBe(c.expected);
    });

    it.each(cases.leverage)("$leverage x under a $cap x cap → $valid", (c) => {
        expect(isValidLeverage(c.leverage, c.cap)).toBe(c.valid);
    });

    it("rejects non-finite leverage", () => {
        expect(isValidLeverage(Number.NaN, 10)).toBe(false);
        expect(isValidLeverage(Number.POSITIVE_INFINITY, 10)).toBe(false);
    });
});

describe("web copy of the cases", () => {
    it("is identical (the web Docker build only sees apps/web)", () => {
        const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
        expect(read("../../../../web/src/lib/__tests__/marginCases.json")).toBe(read("./marginCases.json"));
    });
});
