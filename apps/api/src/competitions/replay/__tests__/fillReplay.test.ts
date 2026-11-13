import { describe, it, expect } from "vitest";
import { fillTrips, reconstructFillCurve, type ReplayFill } from "../fillReplay";
import type { MarkPriceLookup } from "../reconstructPnlCurve";
import { replayClock, replayMarkPrice } from "../replayClock";

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
    it("a fill counts from its own time; open size is marked at the price known then", () => {
        const fills = [
            fill("BUY", "1", "100", "0", t(1) + 60_000),
            fill("SELL", "1", "130", "0", t(3) + 10),
        ];
        const clock = [t(0), t(1), t(1) + 60_000, t(2), t(3), t(3) + 10, t(4)];
        const marks: Record<number, number> = { [t(1) + 60_000]: 100, [t(2)]: 110, [t(3)]: 120, [t(3) + 10]: 130 };
        const curve = reconstructFillCurve(fills, clock, (_p, ts) => marks[ts] ?? null, CAP);
        expect(curve.map((c) => c.unrealizedPnl)).toEqual([0, 0, 0, 10, 20, 0, 0]);
        expect(curve.map((c) => c.realizedPnl)).toEqual([0, 0, 0, 0, 0, 30, 30]);
    });

    it("fees come off at the fill that paid them, and the end is realized − fees (the headline)", () => {
        const fills = [
            fill("BUY", "0.5", "50000", "12.5", t(0)),
            fill("SELL", "0.5", "50400", "12.6", t(2)),
        ];
        const curve = reconstructFillCurve(fills, [t(0), t(1), t(2)], flat(50200), CAP);
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
        const [p] = reconstructFillCurve(fills, [t(0)], mark, CAP);
        expect(p!.unrealizedPnl).toBeCloseTo(10 + 20, 10);
    });
});

/**
 * Prod (Bertito vs berto, a 15-minute match): the stored candles in the
 * replay window ended before the fills (one candle), and the old curve was
 * sampled only at candle times, a fill counting once a candle at or after it
 * existed. No fill was ever applied: one point, 0.00, no fees, never the final.
 */
describe("a match whose candles end before its fills (prod shape)", () => {
    const MIN = 60_000;
    const start = 10 * FIVE;
    const end = start + 15 * MIN;
    const fills = [
        fill("BUY", "0.2", "83010", "8.30", start + 1 * MIN),
        fill("SELL", "0.2", "82990", "8.30", start + 9 * MIN),
    ];
    // One stored candle, an hour before the match.
    const candles = new Map([["BTC", [{ ts: start - 12 * FIVE, c: 83000 }]]]);

    it("still has a point at every fill and ends on realized − fees at the match end", () => {
        const clock = replayClock(start, end, [start - 11 * FIVE], fills.map((f) => f.ts));
        expect(clock).toEqual([start, start + MIN, start + 9 * MIN, end]);
        const curve = reconstructFillCurve(fills, clock, replayMarkPrice(candles, FIVE, fills), CAP);
        expect(curve.map((p) => p.ts)).toEqual(clock);
        expect(curve[0]!.pnlPct).toBe(0);
        // The opening fill: marked at its own price, so the fee alone.
        expect(curve[1]!.unrealizedPnl).toBe(0);
        expect(curve[1]!.realizedPnl).toBeCloseTo(-8.3, 10);
        const headline = ((0.2 * (82990 - 83010) - 16.6) / CAP) * 100;
        expect(curve[2]!.pnlPct).toBeCloseTo(headline, 12);
        expect(curve[3]!.pnlPct).toBeCloseTo(headline, 12);
    });
});
