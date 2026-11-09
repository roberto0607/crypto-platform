import { describe, it, expect } from "vitest";
import { fillTrips, reconstructFillCurve, type ReplayFill } from "../fillReplay";
import type { MarkPriceLookup } from "../reconstructPnlCurve";

const FIVE = 300_000;
const t = (i: number) => i * FIVE;
const CAP = 50_000;
const flat = (price: number): MarkPriceLookup => () => price;

const fill = (side: "BUY" | "SELL", qty: string, price: string, fee: string, ts: number, pairId = "BTC"): ReplayFill =>
    ({ pairId, side, qty, price, fee, ts });

describe("fillTrips: a player's round trips from their fills", () => {
    it("open, add, close: one LONG with its average entry, exit and net P&L", () => {
        const trips = fillTrips([
            fill("BUY", "1", "100", "0.05", t(1)),
            fill("BUY", "1", "110", "0.055", t(2)),
            fill("SELL", "2", "120", "0.12", t(5)),
        ]);
        expect(trips).toEqual([{
            pairId: "BTC", side: "LONG", entryPrice: 105, qty: 2, exitPrice: 120,
            openedAt: t(1), closedAt: t(5), pnl: 30 - 0.225,
        }]);
    });

    it("a flip closes one trip and opens the next; its fee is split by size", () => {
        const trips = fillTrips([
            fill("BUY", "1", "100", "0.05", t(1)),
            fill("SELL", "4", "90", "0.18", t(2)),   // closes 1 (fee 0.045), opens a 3 short (fee 0.135)
            fill("BUY", "3", "80", "0.12", t(3)),
        ]);
        expect(trips).toHaveLength(2);
        expect(trips[0]).toMatchObject({ side: "LONG", qty: 1, entryPrice: 100, exitPrice: 90, closedAt: t(2) });
        expect(trips[0]!.pnl).toBeCloseTo(-10 - 0.05 - 0.045, 10);
        expect(trips[1]).toMatchObject({ side: "SHORT", qty: 3, entryPrice: 90, exitPrice: 80, openedAt: t(2), closedAt: t(3) });
        expect(trips[1]!.pnl).toBeCloseTo(30 - 0.135 - 0.12, 10);
    });

    it("still open at the end: no exit", () => {
        const [trip] = fillTrips([fill("SELL", "1", "100", "0.05", t(1))]);
        expect(trip).toMatchObject({ side: "SHORT", exitPrice: null, closedAt: null });
    });
});

describe("reconstructFillCurve", () => {
    it("marks open size at each candle's close; a fill counts from the candle it lands in", () => {
        const fills = [
            fill("BUY", "1", "100", "0", t(1) + 60_000),   // inside candle 1
            fill("SELL", "1", "130", "0", t(3) + 10),
        ];
        const marks: Record<number, number> = { [t(0)]: 100, [t(1)]: 110, [t(2)]: 120, [t(3)]: 130, [t(4)]: 140 };
        const curve = reconstructFillCurve(fills, [t(0), t(1), t(2), t(3), t(4)], (_p, ts) => marks[ts] ?? null, CAP, FIVE);
        expect(curve.map((c) => c.unrealizedPnl)).toEqual([0, 10, 20, 0, 0]);
        expect(curve.map((c) => c.realizedPnl)).toEqual([0, 0, 0, 30, 30]);
    });

    it("fees come off as they're paid, and the end is realized − fees (the headline)", () => {
        const fills = [
            fill("BUY", "0.5", "50000", "12.5", t(0)),
            fill("SELL", "0.5", "50400", "12.6", t(2)),
        ];
        const curve = reconstructFillCurve(fills, [t(0), t(1), t(2)], flat(50200), CAP, FIVE);
        expect(curve[0]!.realizedPnl).toBeCloseTo(-12.5, 10);
        expect(curve[0]!.unrealizedPnl).toBeCloseTo(100, 10);
        const last = curve.at(-1)!;
        expect(last.unrealizedPnl).toBe(0);
        expect(last.realizedPnl).toBeCloseTo(200 - 25.1, 10);
        expect(last.pnlPct).toBeCloseTo(((200 - 25.1) / CAP) * 100, 12);
        expect(last.equity).toBeCloseTo(CAP + 200 - 25.1, 8);
    });

    it("a short is marked the other way; pairs are independent", () => {
        const fills = [
            fill("SELL", "1", "100", "0", t(0), "BTC"),
            fill("BUY", "10", "10", "0", t(0), "SOL"),
        ];
        const mark: MarkPriceLookup = (p) => (p === "BTC" ? 90 : 12);
        const [p] = reconstructFillCurve(fills, [t(0)], mark, CAP, FIVE);
        expect(p!.unrealizedPnl).toBeCloseTo(10 + 20, 10);
    });
});
