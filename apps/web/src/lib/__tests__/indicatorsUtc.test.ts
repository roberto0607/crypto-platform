import { describe, it, expect, afterAll } from "vitest";
import { prevPeriodHighLow, computeVWAP, type Candle } from "@/lib/indicators";
import fixture from "./fixtures/btcKeyLevels.json";

// Real BTC/USD candles (Coinbase) from the audit DB, 2026-11-03 ~04:55Z.
// Rows: [utcSec, high, low, close, volume]. 1h ends at the last CLOSED bar
// (03:00Z); 1d at Nov 2; 1w at the week of Oct 26 — what the chart's
// renderOverlays receives (closed candles only).
// True previous UTC day (Nov 2): H 78,762.30 / L 76,553.00.
// True previous week (Oct 26): H 81,890.00 / L 76,141.02.

const TF_SEC = { "1h": 3600, "1d": 86400, "1w": 604800 } as const;
// Node re-reads TZ when process.env.TZ changes (web tsconfig has no Node types).
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ORIGINAL_TZ = env.TZ;
afterAll(() => { env.TZ = ORIGINAL_TZ; });

/** What CandlestickChart does: shift UTC seconds by the viewer's offset for display. */
function chartCandles(tf: keyof typeof TF_SEC, tz: string): { candles: Candle[]; offset: number } {
    env.TZ = tz;
    const offset = new Date(fixture["1h"].at(-1)![0]! * 1000).getTimezoneOffset() * -60;
    const candles = (fixture[tf] as number[][]).map(([t, high, low, close, volume]) => ({
        time: t! + offset, open: close!, high: high!, low: low!, close: close!, volume: volume!,
    }));
    return { candles, offset };
}

const levels = (tf: keyof typeof TF_SEC, tz: string) => {
    const { candles, offset } = chartCandles(tf, tz);
    return prevPeriodHighLow(candles, { candleSec: TF_SEC[tf], tzOffsetSec: offset, period: tf === "1w" ? "week" : "day" });
};

describe("PDH/PDL — previous UTC period, whatever the viewer's timezone (audit B-02/B-03)", () => {
    for (const tz of ["America/New_York", "Asia/Tokyo", "UTC"]) {
        it(`1h, ${tz}: previous UTC day = Nov 2`, () => {
            expect(levels("1h", tz)).toEqual({ pdh: 78762.3, pdl: 76553 });
        });
        it(`1d, ${tz}: previous day = Nov 2 (not Nov 1)`, () => {
            expect(levels("1d", tz)).toEqual({ pdh: 78762.3, pdl: 76553 });
        });
        it(`1w, ${tz}: previous week = Oct 26 (not Oct 19)`, () => {
            expect(levels("1w", tz)).toEqual({ pdh: 81890, pdl: 76141.02 });
        });
    }

    it("New York and Tokyo get identical levels", () => {
        expect(levels("1h", "America/New_York")).toEqual(levels("1h", "Asia/Tokyo"));
    });

    it("just after UTC midnight (first bar of the day still forming) the previous day is still yesterday", () => {
        // Closed bars through Nov 2 23:00Z only.
        const { candles, offset } = chartCandles("1h", "America/New_York");
        const upToMidnight = candles.filter((c) => c.time - offset < Date.UTC(2026, 10, 3) / 1000);
        expect(prevPeriodHighLow(upToMidnight, { candleSec: 3600, tzOffsetSec: offset, period: "day" }))
            .toEqual({ pdh: 78762.3, pdl: 76553 });
    });
});

describe("VWAP resets at UTC midnight, whatever the viewer's timezone (audit B-02)", () => {
    const vwap = (tz: string) => {
        const { candles, offset } = chartCandles("1h", tz);
        return computeVWAP(candles, offset).map((p) => ({ utc: p.time - offset, value: p.value }));
    };

    it("New York and Tokyo get identical VWAP values", () => {
        expect(vwap("America/New_York")).toEqual(vwap("Asia/Tokyo"));
    });

    it("the 00:00Z bar starts a new session (VWAP = its typical price)", () => {
        const nov2 = Date.UTC(2026, 10, 2) / 1000;
        const row = fixture["1h"].find((r) => r[0] === nov2)!;
        const typical = (row[1]! + row[2]! + row[3]!) / 3;
        const point = vwap("America/New_York").find((p) => p.utc === nov2)!;
        expect(point.value).toBeCloseTo(typical, 8);
    });
});
