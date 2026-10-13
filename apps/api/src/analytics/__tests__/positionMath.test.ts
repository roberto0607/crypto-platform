/**
 * positionMath.test.ts — the position fill math, longs and shorts.
 *
 * A short is the mirror of a long: adding averages the entry, reducing
 * realizes P&L on the reduced part at the entry and leaves the entry alone,
 * going flat resets the entry, and crossing through zero opens the rest at
 * the fill price.
 */
import { describe, it, expect } from "vitest";
import { applyFill, type PositionState } from "../positionMath";
import { D, ZERO } from "../../utils/decimal";

const FLAT: PositionState = { qty: ZERO, avgEntry: ZERO, realizedPnl: ZERO };

/** Apply fills in order, starting flat. */
function run(fills: [side: "BUY" | "SELL", qty: string, price: string][]): PositionState {
    return fills.reduce((pos, [side, qty, price]) => applyFill(pos, side, D(qty), D(price)), FLAT);
}

function expectPos(pos: PositionState, qty: string, avgEntry: string, realizedPnl: string) {
    expect({
        qty: pos.qty.toFixed(8),
        avgEntry: pos.avgEntry.toFixed(8),
        realizedPnl: pos.realizedPnl.toFixed(8),
    }).toEqual({
        qty: D(qty).toFixed(8),
        avgEntry: D(avgEntry).toFixed(8),
        realizedPnl: D(realizedPnl).toFixed(8),
    });
}

describe("applyFill — shorts", () => {
    it("opens a short from flat at the fill price", () => {
        expectPos(run([["SELL", "2", "110"]]), "-2", "110", "0");
    });

    it("covering part of a short realizes P&L and keeps the entry (short 2 @ 110, buy 1 @ 90)", () => {
        expectPos(run([["SELL", "2", "110"], ["BUY", "1", "90"]]), "-1", "110", "20");
    });

    it("covering the rest goes flat and resets the entry", () => {
        expectPos(run([["SELL", "2", "110"], ["BUY", "1", "90"], ["BUY", "1", "100"]]), "0", "0", "30");
    });

    it("covering at a higher price realizes a loss", () => {
        expectPos(run([["SELL", "1", "100"], ["BUY", "1", "120"]]), "0", "0", "-20");
    });

    it("adding to a short averages the entry", () => {
        expectPos(run([["SELL", "1", "100"], ["SELL", "1", "120"]]), "-2", "110", "0");
    });

    it("adding unequal sizes weights the entry by size", () => {
        expectPos(run([["SELL", "1", "100"], ["SELL", "3", "120"]]), "-4", "115", "0");
    });

    it("flipping short → long realizes the whole short and opens the rest at the fill price", () => {
        expectPos(run([["SELL", "1", "100"], ["BUY", "3", "90"]]), "2", "90", "10");
    });

    it("a stale entry from a closed short doesn't leak into the next long", () => {
        expectPos(run([["SELL", "1", "100"], ["BUY", "1", "90"], ["BUY", "1", "50"]]), "1", "50", "10");
    });
});

describe("applyFill — longs (unchanged)", () => {
    it("opens a long from flat at the fill price", () => {
        expectPos(run([["BUY", "1", "100"]]), "1", "100", "0");
    });

    it("adding to a long averages the entry", () => {
        expectPos(run([["BUY", "1", "100"], ["BUY", "1", "120"]]), "2", "110", "0");
    });

    it("selling part of a long realizes P&L and keeps the entry", () => {
        expectPos(run([["BUY", "1", "100"], ["BUY", "1", "120"], ["SELL", "1", "130"]]), "1", "110", "20");
    });

    it("selling the rest goes flat and resets the entry", () => {
        expectPos(run([["BUY", "2", "100"], ["SELL", "2", "90"]]), "0", "0", "-20");
    });

    it("flipping long → short realizes the whole long and opens the rest at the fill price", () => {
        expectPos(run([["BUY", "1", "100"], ["SELL", "3", "110"]]), "-2", "110", "10");
    });
});
