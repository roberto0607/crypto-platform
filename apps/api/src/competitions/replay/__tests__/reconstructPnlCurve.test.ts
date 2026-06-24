import { describe, it, expect } from "vitest";
import {
    reconstructPnlCurve,
    type NormalizedPosition,
    type MarkPriceLookup,
} from "../reconstructPnlCurve";

// Helper: build a markPrice lookup from a per-pair {ts -> close} table with
// forward-fill (last close at-or-before T).
function makeMark(table: Record<string, Array<[number, number]>>): MarkPriceLookup {
    return (pairId, ts) => {
        const series = table[pairId];
        if (!series) return null;
        let val: number | null = null;
        for (const [t, close] of series) {
            if (t <= ts) val = close;
            else break;
        }
        return val;
    };
}

const CAP = 50_000;
// 5-minute grid
const t = (i: number) => i * 300_000;

describe("reconstructPnlCurve", () => {
    it("1. LONG profits as price rises — unrealized grows candle over candle", () => {
        const pos: NormalizedPosition[] = [
            { pairId: "BTC", side: "LONG", entryPrice: 100, qty: 2, openedAt: t(0), closedAt: t(100), realizedPnl: 999 },
        ];
        const times = [t(0), t(1), t(2), t(3)];
        const mark = makeMark({ BTC: [[t(0), 100], [t(1), 110], [t(2), 120], [t(3), 130]] });
        const curve = reconstructPnlCurve(pos, times, mark, CAP);

        // unrealized = (close-100)*2 → 0, 20, 40, 60 ; strictly increasing
        expect(curve.map((c) => c.unrealizedPnl)).toEqual([0, 20, 40, 60]);
        expect(curve.every((c, i) => i === 0 || c.unrealizedPnl > curve[i - 1]!.unrealizedPnl)).toBe(true);
        expect(curve.every((c) => c.realizedPnl === 0)).toBe(true); // never closed in-window
    });

    it("2. SHORT profits as price FALLS — sign correctness", () => {
        const pos: NormalizedPosition[] = [
            { pairId: "ETH", side: "SHORT", entryPrice: 100, qty: 3, openedAt: t(0), closedAt: t(100), realizedPnl: 0 },
        ];
        const times = [t(0), t(1), t(2)];
        const mark = makeMark({ ETH: [[t(0), 100], [t(1), 90], [t(2), 80]] });
        const curve = reconstructPnlCurve(pos, times, mark, CAP);

        // SHORT: (entry-close)*qty → 0, 30, 60 (POSITIVE as price falls)
        expect(curve.map((c) => c.unrealizedPnl)).toEqual([0, 30, 60]);
        // and a SHORT must LOSE if price rises:
        const rising = reconstructPnlCurve(pos, [t(1)], makeMark({ ETH: [[t(0), 100], [t(1), 110]] }), CAP);
        expect(rising[0]!.unrealizedPnl).toBe(-30);
    });

    it("3. opens then closes mid-window — ramps while open, FLAT at stored realized after close", () => {
        const pos: NormalizedPosition[] = [
            { pairId: "BTC", side: "LONG", entryPrice: 100, qty: 1, openedAt: t(1), closedAt: t(3), realizedPnl: 25 },
        ];
        const times = [t(0), t(1), t(2), t(3), t(4)];
        const mark = makeMark({ BTC: [[t(0), 100], [t(1), 100], [t(2), 115], [t(3), 130], [t(4), 999]] });
        const curve = reconstructPnlCurve(pos, times, mark, CAP);

        expect(curve[0]).toMatchObject({ realizedPnl: 0, unrealizedPnl: 0 }); // before open
        expect(curve[1]).toMatchObject({ realizedPnl: 0, unrealizedPnl: 0 }); // opens at t1, close=100
        expect(curve[2]!.unrealizedPnl).toBe(15); // open, marked to 115
        // closedAt = t(3): at t(3) it's realized (closedAt <= T), frozen at stored 25
        expect(curve[3]).toMatchObject({ realizedPnl: 25, unrealizedPnl: 0 });
        expect(curve[4]).toMatchObject({ realizedPnl: 25, unrealizedPnl: 0 }); // FLAT, ignores 999 mark
    });

    it("4. two concurrent positions (different pairs/sides) sum per candle", () => {
        const pos: NormalizedPosition[] = [
            { pairId: "BTC", side: "LONG", entryPrice: 100, qty: 1, openedAt: t(0), closedAt: t(100), realizedPnl: 0 },
            { pairId: "ETH", side: "SHORT", entryPrice: 50, qty: 2, openedAt: t(0), closedAt: t(100), realizedPnl: 0 },
        ];
        const times = [t(1)];
        const mark = makeMark({ BTC: [[t(1), 120]], ETH: [[t(1), 40]] });
        const curve = reconstructPnlCurve(pos, times, mark, CAP);
        // BTC long: (120-100)*1 = 20 ; ETH short: (50-40)*2 = 20 ; sum = 40
        expect(curve[0]!.unrealizedPnl).toBe(40);
        expect(curve[0]!.equity).toBe(CAP + 40);
    });

    it("5. ORACLE — final point pnlPct == Σ(stored pnl)/capital*100 exactly", () => {
        // three closed positions; stored pnls sum to 2600 → 5.2% of 50000
        const pos: NormalizedPosition[] = [
            { pairId: "BTC", side: "LONG", entryPrice: 100, qty: 1, openedAt: t(0), closedAt: t(2), realizedPnl: 2000 },
            { pairId: "ETH", side: "SHORT", entryPrice: 50, qty: 1, openedAt: t(1), closedAt: t(4), realizedPnl: -400 },
            { pairId: "SOL", side: "LONG", entryPrice: 10, qty: 1, openedAt: t(2), closedAt: t(6), realizedPnl: 1000 },
        ];
        const times = [t(0), t(3), t(7)]; // last time is past every closedAt
        const mark = makeMark({ BTC: [[t(0), 100]], ETH: [[t(0), 50]], SOL: [[t(0), 10]] });
        const curve = reconstructPnlCurve(pos, times, mark, CAP);

        const sumStored = 2000 - 400 + 1000; // 2600
        const finalPct = curve[curve.length - 1]!.pnlPct;
        expect(finalPct).toBeCloseTo((sumStored / CAP) * 100, 10); // 5.2, exact
        expect(curve[curve.length - 1]!.unrealizedPnl).toBe(0); // all closed at final
    });

    it("6. curve length == candleTimes; ascending ts; no NaN; equity defined", () => {
        const pos: NormalizedPosition[] = [
            { pairId: "BTC", side: "LONG", entryPrice: 100, qty: 1, openedAt: t(1), closedAt: t(3), realizedPnl: 10 },
        ];
        const times = [t(0), t(1), t(2), t(3), t(4)];
        const mark = makeMark({ BTC: [[t(0), 100], [t(2), 105]] });
        const curve = reconstructPnlCurve(pos, times, mark, CAP);

        expect(curve).toHaveLength(times.length);
        expect(curve.map((c) => c.ts)).toEqual(times);
        expect(curve.every((c, i) => i === 0 || c.ts > curve[i - 1]!.ts)).toBe(true);
        for (const c of curve) {
            expect(Number.isNaN(c.equity)).toBe(false);
            expect(Number.isNaN(c.pnlPct)).toBe(false);
            expect(c.equity).toBeTypeOf("number");
        }
    });
});
