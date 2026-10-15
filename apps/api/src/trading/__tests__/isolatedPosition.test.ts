/**
 * isolatedPosition.test.ts: one fill applied to an isolated position (pure).
 *
 * Numbers are the design's worked example (docs/designs/2026-10-13-leverage-
 * design.md §3): $50 at 10x long BTC at $83,000, MMR 0.5%, taker 5 bps.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { D, ZERO } from "../../utils/decimal";
import { applyIsolatedFill, FLAT, type IsolatedState } from "../isolatedPosition";

const MMR = 50;
const fee = (qty: string, price: string, bps = 5) => D(qty).mul(price).mul(bps).div(10000);
/** Rounded half-up to the cent, as the design doc rounds. */
const cents = (d: Decimal | null) => (d === null ? null : Number(d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)));

/** Open from flat: the design's $50 @ 10x at 83,000 (size 0.00602409, rounded down). */
function open10x(side: "BUY" | "SELL"): IsolatedState {
    const r = applyIsolatedFill(FLAT, side, D("0.00602409"), D("83000"), fee("0.00602409", "83000"), D(10), MMR);
    return r.next;
}

describe("open from flat", () => {
    it("10x long: margin = notional / 10, liq 75,075.38, epoch + 1", () => {
        const r = applyIsolatedFill(FLAT, "BUY", D("0.00602409"), D("83000"), fee("0.00602409", "83000"), D(10), MMR);
        expect(r.reduce).toBeNull();
        expect(r.open!.margin.toFixed(8)).toBe("49.99994700");
        expect(r.open!.fee.toFixed(8)).toBe("0.24999973");
        expect(r.next.qty.toFixed(8)).toBe("0.00602409");
        expect(r.next.entry.toFixed(8)).toBe("83000.00000000");
        expect(r.next.margin.toFixed(8)).toBe("49.99994700");
        expect(r.next.leverage.toNumber()).toBe(10);
        expect(r.next.epoch).toBe(1);
        expect(r.openedFromFlat).toBe(true);
        expect(cents(r.next.liqPrice)).toBe(75075.38);
    });

    it("10x short: liq 90,845.77", () => {
        const s = open10x("SELL");
        expect(s.qty.toFixed(8)).toBe("-0.00602409");
        expect(cents(s.liqPrice)).toBe(90845.77);
    });

    it("1x long can't be liquidated above 0", () => {
        const r = applyIsolatedFill(FLAT, "BUY", D("1"), D("83000"), ZERO, D(1), MMR);
        expect(r.next.margin.toFixed(8)).toBe("83000.00000000");
        expect(r.next.liqPrice!.toNumber()).toBe(0);
    });
});

describe("increase", () => {
    it("add $50 @ 10x at 80,000: averaged entry, summed margin, liq 73,693.62, same epoch", () => {
        const s = open10x("BUY");
        const r = applyIsolatedFill(s, "BUY", D("0.00625"), D("80000"), fee("0.00625", "80000"), D(10), MMR);
        expect(r.reduce).toBeNull();
        expect(r.openedFromFlat).toBe(false);
        expect(r.next.qty.toFixed(8)).toBe("0.01227409");
        expect(cents(r.next.entry)).toBe(81472.39);
        expect(r.next.margin.toFixed(8)).toBe("99.99994700");
        expect(cents(r.next.liqPrice)).toBe(73693.62);
        expect(r.next.epoch).toBe(1);
    });
});

describe("reduce", () => {
    it("partial close of half at 85,000: pro-rata release, P&L, liq unchanged", () => {
        const s = open10x("BUY");
        const closeFee = fee("0.00301205", "85000");
        const r = applyIsolatedFill(s, "SELL", D("0.00301205"), D("85000"), closeFee, D(1), MMR);
        expect(r.open).toBeNull();
        const red = r.reduce!;
        expect(red.closeQty.toFixed(8)).toBe("0.00301205");
        expect(red.pnl.toFixed(8)).toBe("6.02410000");
        expect(cents(red.released)).toBe(25.00);
        expect(cents(red.settlement.credit)).toBe(30.90);
        expect(red.settlement.shortfall.isZero()).toBe(true);
        expect(r.next.qty.toFixed(8)).toBe("0.00301204");
        expect(r.next.entry.toFixed(8)).toBe("83000.00000000");
        expect(cents(r.next.margin)).toBe(25.00);
        expect(cents(r.next.liqPrice)).toBe(75075.38);
        expect(r.next.epoch).toBe(1);
    });

    it("full close: margin back, flat, liq null, entry 0", () => {
        const s = open10x("BUY");
        const r = applyIsolatedFill(s, "SELL", D("0.00602409"), D("84000"), ZERO, D(1), MMR);
        expect(r.reduce!.released.toFixed(8)).toBe("49.99994700");
        expect(r.reduce!.pnl.toFixed(8)).toBe("6.02409000");
        expect(r.next.qty.isZero()).toBe(true);
        expect(r.next.margin.isZero()).toBe(true);
        expect(r.next.liqPrice).toBeNull();
        expect(r.next.entry.isZero()).toBe(true);
    });

    it("gap past bankruptcy: loss capped at the margin, shortfall recorded, credit 0", () => {
        const s = open10x("BUY");
        const closeFee = fee("0.00602409", "74000");
        const r = applyIsolatedFill(s, "SELL", D("0.00602409"), D("74000"), closeFee, D(1), MMR);
        const st = r.reduce!.settlement;
        expect(st.credit.isZero()).toBe(true);
        expect(st.bookedPnl.toFixed(8)).toBe("-49.99994700");
        expect(st.bookedFee.isZero()).toBe(true);
        expect(cents(st.shortfall)).toBe(4.22);
    });

    it("a reduce ignores the order's leverage (the position keeps its own)", () => {
        const s = open10x("SELL");
        const r = applyIsolatedFill(s, "BUY", D("0.00100000"), D("83000"), ZERO, D(3), MMR);
        expect(r.next.leverage.toNumber()).toBe(10);
    });
});

describe("flip", () => {
    it("closes the whole position, then opens the rest from flat at the fill, new epoch", () => {
        const s = open10x("BUY");
        const fillFee = fee("0.01000000", "84000");
        const r = applyIsolatedFill(s, "SELL", D("0.01"), D("84000"), fillFee, D(5), MMR);
        expect(r.reduce!.closeQty.toFixed(8)).toBe("0.00602409");
        expect(r.open!.qty.toFixed(8)).toBe("0.00397591");
        // Fee split pro rata between the closing and opening parts.
        expect(r.reduce!.fee.plus(r.open!.fee).toFixed(8)).toBe(fillFee.toFixed(8));
        expect(r.open!.margin.toFixed(8)).toBe(D("0.00397591").mul(84000).div(5).toFixed(8));
        expect(r.next.qty.toFixed(8)).toBe("-0.00397591");
        expect(r.next.entry.toFixed(8)).toBe("84000.00000000");
        expect(r.next.leverage.toNumber()).toBe(5);
        expect(r.next.epoch).toBe(2);
        expect(r.openedFromFlat).toBe(true);
    });
});

describe("rounding", () => {
    it("margin rounds down to 8 dp (never locks more than notional / L)", () => {
        const r = applyIsolatedFill(FLAT, "BUY", D("0.00000003"), D("1"), ZERO, D(3), MMR);
        expect(r.open!.margin.toFixed(8)).toBe("0.00000001");
    });
});
