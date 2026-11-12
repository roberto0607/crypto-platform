/**
 * Higher-timeframe lines: the chart's assembly (lib/htfLines) vs the server's
 * values (packages/indicators computeHtfParitySeries, pinned in golden.json
 * and checked by the API suite) on the shared Coinbase BTC-USD fixture —
 * every 4h bar, in several viewer timezones (the chart shifts times by the
 * viewer's UTC offset), including the bar that opens at each daily/weekly
 * close.
 */
import { describe, it, expect } from "vitest";
import {
    HTF_PARITY_LINES, computeHtfParitySeries, compareSeries, fingerprint, fixtureCandles, fromGolden,
    htfValueAt, computeMovingAverage, TIMEFRAME_SEC,
    type Candle, type CandleFixture, type GoldenFile, type SeriesMap,
} from "@/lib/sharedIndicators";
import { buildHtfLine, htfBarsNeeded, lineMode, movingAverageLabel } from "@/lib/htfLines";

// Same fixture loading as sharedIndicatorsParity.test.ts (files live outside apps/web).
const fsModule = "node:fs";
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: "utf8"): string };
const repoRoot = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "").replace(/\/apps\/web\/src\/.*$/, ""));
const readJson = <T,>(rel: string): T => JSON.parse(fs.readFileSync(`${repoRoot}/${rel}`, "utf8")) as T;
const fixture = readJson<CandleFixture>("packages/indicators/fixtures/btcusd-coinbase.json");
const golden = readJson<GoldenFile>("packages/indicators/fixtures/golden.json");

const shift = (cs: Candle[], tz: number) => cs.map((c) => ({ ...c, time: c.time + tz }));
const h4 = fixtureCandles(fixture.timeframes["4h"]!);
const server = computeHtfParitySeries(fixture);

/** The chart's lines on the fixture, as the chart draws them (shifted), shifted back to UTC. */
function chartSeries(tz: number): SeriesMap {
    const out: SeriesMap = {};
    for (const [name, tf, type, length] of HTF_PARITY_LINES) {
        const line = buildHtfLine({ type, length }, tf, shift(h4, tz), shift(fixtureCandles(fixture.timeframes[tf]!), tz));
        out[name] = line.step.map((p) => ({ time: p.time - tz, value: p.value }));
    }
    return out;
}

describe.each([["UTC", 0], ["New York (UTC-5)", -5 * 3600], ["India (UTC+5:30)", 5.5 * 3600]] as const)(
    "chart HTF lines == server HTF values, viewer in %s",
    (_label, tz) => {
        const chart = chartSeries(tz);

        it("every 4h bar of every line, exactly", () => {
            expect(compareSeries(chart, server, 0)).toEqual([]);
            expect(compareSeries(fingerprint(chart), fromGolden(golden.htf!))).toEqual([]);
        });

        it("at the exact daily / weekly close the 4h bar opening then shows the just-closed bar", () => {
            for (const [name, tf, type, length] of HTF_PARITY_LINES) {
                const sec = TIMEFRAME_SEC[tf];
                const htf = computeMovingAverage(fixtureCandles(fixture.timeframes[tf]!), type, length);
                const byOpen = new Map(htf.map((p) => [p.time, p.value]));
                let n = 0;
                for (const p of chart[name]!) {
                    const justClosed = byOpen.get(p.time - sec);
                    if (justClosed === undefined) continue;
                    n++;
                    expect(p.value).toBe(justClosed);
                    expect(p.value).toBe(htfValueAt(htf, sec, p.time));
                }
                expect(n, name).toBeGreaterThan(tf === "1d" ? 50 : 10);
            }
        });
    },
);

describe("forming value (dotted, right edge)", () => {
    const daily = fixtureCandles(fixture.timeframes["1d"]!);
    // 4h bars of the last fixture day (2026-11-08), with the daily bars up to the day before as "closed"
    const lastDay = daily.at(-1)!;
    const closed = daily.slice(0, -1);
    const dayBars = h4.filter((c) => c.time >= lastDay.time && c.time < lastDay.time + 86_400);
    const chartBars = h4.filter((c) => c.time < lastDay.time + 86_400);

    it("spans the forming day's 4h bars at the SMA the day would have if it closed now", () => {
        const line = buildHtfLine({ type: "SMA", length: 200 }, "1d", chartBars, closed);
        expect(line.forming).toEqual({
            from: dayBars[0]!.time,
            to: dayBars.at(-1)!.time,
            value: expect.closeTo(computeMovingAverage(daily, "SMA", 200).at(-1)!.value, 6),
        });
        // the step line keeps the last CLOSED day's value through the forming day
        const sma = computeMovingAverage(closed, "SMA", 200);
        expect(line.step.at(-1)!.value).toBe(sma.at(-1)!.value);
    });

    it("none once the chart is past the bar after the last closed one (candles about to refresh)", () => {
        expect(buildHtfLine({ type: "SMA", length: 200 }, "1d", chartBars, closed.slice(0, -1)).forming).toBeNull();
    });
});

describe("line mode, label and warm-up", () => {
    it("draws on the chart, as a higher timeframe, or not at all", () => {
        expect(lineMode({}, "4h")).toBe("chart");
        expect(lineMode({ timeframe: "chart" }, "4h")).toBe("chart");
        expect(lineMode({ timeframe: "4h" }, "4h")).toBe("chart");
        expect(lineMode({ timeframe: "1d" }, "4h")).toBe("htf");
        expect(lineMode({ timeframe: "1w" }, "1h")).toBe("htf");
        expect(lineMode({ timeframe: "1h" }, "1d")).toBe("lower");
    });

    it("labels name the timeframe", () => {
        expect(movingAverageLabel({ type: "SMA", length: 200, timeframe: "1d" })).toBe("SMA 200 (1D)");
        expect(movingAverageLabel({ type: "SMA", length: 50, timeframe: "1w" })).toBe("SMA 50 (1W)");
        expect(movingAverageLabel({ type: "EMA", length: 21 })).toBe("EMA 21");
    });

    it("loads the warm-up plus the span shown: daily SMA 200 over 750 4h bars ≈ 200 + 125 days", () => {
        const bars = h4.slice(-750);
        expect(htfBarsNeeded({ type: "SMA", length: 200 }, bars, 86_400)).toBe(200 + Math.ceil((749 * 14_400) / 86_400) + 2);
        expect(htfBarsNeeded({ type: "EMA", length: 50 }, bars, 604_800)).toBe(250 + Math.ceil((749 * 14_400) / 604_800) + 2);
    });
});
