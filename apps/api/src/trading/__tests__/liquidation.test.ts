/**
 * liquidation.test.ts: the liquidation rule and the matching engine's
 * re-check (liquidation.ts), pure.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { breaches, confirmLiquidation, markOf, LiquidationNotNeeded } from "../liquidation";
import type { IsolatedState } from "../isolatedPosition";

const D = (v: string | number) => new Decimal(v);
const long: IsolatedState = {
    qty: D("0.00602409"), entry: D("83000"), margin: D("49.999947"), leverage: D(10), epoch: 3,
    liqPrice: D("75075.37688442"),
};
const short: IsolatedState = { ...long, qty: long.qty.neg(), liqPrice: D("90845.77114427") };

describe("breaches", () => {
    it("long: at or below the liq price", () => {
        expect(breaches("LONG", long.liqPrice, D("75075.37688442"))).toBe(true);
        expect(breaches("LONG", long.liqPrice, D("75075.37"))).toBe(true);
        expect(breaches("LONG", long.liqPrice, D("75075.38"))).toBe(false);
    });
    it("short: at or above the liq price", () => {
        expect(breaches("SHORT", short.liqPrice, D("90845.77114427"))).toBe(true);
        expect(breaches("SHORT", short.liqPrice, D("90845.78"))).toBe(true);
        expect(breaches("SHORT", short.liqPrice, D("90845.77"))).toBe(false);
    });
    it("no liq price (flat, SPOT) never breaches", () => {
        expect(breaches("LONG", null, D(0))).toBe(false);
    });
    it("the mark is the book mid", () => {
        expect(markOf({ bestBid: D("75060"), bestAsk: D("75061") }).toString()).toBe("75060.5");
    });
});

describe("confirmLiquidation", () => {
    const reason = (f: () => unknown) => {
        try {
            f();
        } catch (e) {
            return e instanceof LiquidationNotNeeded ? e.reason : String(e);
        }
        return "confirmed";
    };
    const mark = D("75000");

    it("returns the position's own size", () => {
        expect(confirmLiquidation(long, "ISOLATED", { epoch: 3, side: "LONG" }, mark).toString()).toBe("0.00602409");
        expect(confirmLiquidation(short, "ISOLATED", { epoch: 3, side: "SHORT" }, D("91000")).toString()).toBe("0.00602409");
    });
    it("refuses anything that isn't the breaching episode the engine saw", () => {
        expect(reason(() => confirmLiquidation(long, "SPOT", { epoch: 3, side: "LONG" }, mark))).toBe("not_isolated");
        expect(reason(() => confirmLiquidation({ ...long, qty: D(0), liqPrice: null }, "ISOLATED", { epoch: 3, side: "LONG" }, mark))).toBe("flat");
        expect(reason(() => confirmLiquidation(long, "ISOLATED", { epoch: 2, side: "LONG" }, mark))).toBe("epoch_changed");
        expect(reason(() => confirmLiquidation(long, "ISOLATED", { epoch: 3, side: "SHORT" }, mark))).toBe("side_changed");
        expect(reason(() => confirmLiquidation(long, "ISOLATED", { epoch: 3, side: "LONG" }, D("76000")))).toBe("no_breach");
    });
});
