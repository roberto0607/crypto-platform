/**
 * Parity: the API's copy of the shared indicator math, run over a committed
 * fixture of real Coinbase BTC-USD candles, must reproduce the committed
 * golden values (to 1e-9). The web suite runs the same check on its copy and
 * also compares the two copies point by point, so a drift fails CI.
 * Regenerate the golden only for an intended math change:
 *   apps/api/node_modules/.bin/tsx packages/indicators/scripts/genGolden.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeParitySeries, computeHtfParitySeries, compareSeries, fingerprint, fixtureCandles, fromGolden,
  PARITY_TIMEFRAME_SEC, type CandleFixture, type GoldenFile,
} from "../shared";
import * as shared from "../shared";
import * as publicApi from "../index";

const fixtures = new URL("../../../../../packages/indicators/fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("btcusd-coinbase.json", fixtures), "utf8")) as CandleFixture;
const golden = JSON.parse(readFileSync(new URL("golden.json", fixtures), "utf8")) as GoldenFile;

describe.each(Object.keys(PARITY_TIMEFRAME_SEC))("shared indicators on %s BTC-USD", (tf) => {
  const candles = fixtureCandles(fixture.timeframes[tf]!);

  it("has enough bars for a 200-period warm-up and more", () => {
    expect(candles.length).toBeGreaterThanOrEqual(400);
  });

  it("matches the committed golden values", () => {
    const series = computeParitySeries(candles, PARITY_TIMEFRAME_SEC[tf]!);
    expect(compareSeries(fingerprint(series), fromGolden(golden[tf]!))).toEqual([]);
  });
});

describe("higher-timeframe lines on 4h BTC-USD", () => {
  it("match the committed golden values (the chart suite checks its line assembly against the same)", () => {
    expect(compareSeries(fingerprint(computeHtfParitySeries(fixture)), fromGolden(golden.htf!))).toEqual([]);
  });
});

describe("API indicator exports", () => {
  it("are the shared implementations, not a separate copy", () => {
    for (const name of ["computeEMA", "computeRSI", "computeATR", "computeMACD", "computeBollingerBands", "computeVWAP", "computeCandleDelta", "prevPeriodHighLow", "computeSMA", "computePineATR", "computeADX", "computeUTBot", "prevPeriodLevelSeries", "findSwingPoints", "firstRealTime", "htfValueAt", "htfStepSeries", "htfFormingMovingAverage", "computeMovingAverage"] as const) {
      expect(publicApi[name]).toBe(shared[name]);
    }
  });
});
