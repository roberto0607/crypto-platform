/**
 * Parity: the web copy of the shared indicator math must match the committed
 * golden values (to 1e-9) over a committed fixture of real Coinbase BTC-USD
 * candles, and the API copy must be byte-identical to it. The API suite runs
 * the same golden check on its copy, so both copies are the same code giving
 * the same values; any drift fails CI.
 *
 * The fixture, golden and API copy live outside apps/web, which is the web
 * Docker build's whole context (and its `tsc` checks tests too). They are read
 * with node:fs at runtime; CI checks out the full repo. (Vite won't import a
 * module from outside apps/web, so the API copy is compared as source bytes.)
 */
import { describe, it, expect } from "vitest";
import {
  computeParitySeries, compareSeries, fingerprint, fixtureCandles, fromGolden,
  PARITY_TIMEFRAME_SEC, type CandleFixture, type GoldenFile,
} from "@/lib/sharedIndicators";
import * as shared from "@/lib/sharedIndicators";
import * as webIndicators from "@/lib/indicators";

// node:fs through a variable specifier: web has no @types/node, and Vite won't
// import JSON from outside apps/web, so read the files directly.
const fsModule = "node:fs";
const fs = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: string, enc: "utf8"): string;
  readdirSync(path: string): string[];
};
// Plain string math on import.meta.url: Vite rewrites `new URL(x, import.meta.url)`
// as an asset reference, which breaks for paths outside apps/web.
const repoRoot = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "").replace(/\/apps\/web\/src\/.*$/, ""));
const repoFile = (rel: string) => `${repoRoot}/${rel}`;
const readJson = <T,>(rel: string): T => JSON.parse(fs.readFileSync(repoFile(rel), "utf8")) as T;

const fixture = readJson<CandleFixture>("packages/indicators/fixtures/btcusd-coinbase.json");
const golden = readJson<GoldenFile>("packages/indicators/fixtures/golden.json");
const apiCopyDir = repoFile("apps/api/src/indicators/shared");
const webCopyDir = repoFile("apps/web/src/lib/sharedIndicators");

describe.each(Object.keys(PARITY_TIMEFRAME_SEC))("shared indicators on %s BTC-USD", (tf) => {
  const candles = fixtureCandles(fixture.timeframes[tf]!);
  const web = computeParitySeries(candles, PARITY_TIMEFRAME_SEC[tf]!);

  it("web copy matches the committed golden values", () => {
    expect(compareSeries(fingerprint(web), fromGolden(golden[tf]!))).toEqual([]);
  });
});

describe("API copy", () => {
  it("is byte-identical to the web copy", () => {
    const files = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();
    expect(files(apiCopyDir)).toEqual(files(webCopyDir));
    for (const f of files(webCopyDir)) {
      expect(fs.readFileSync(`${apiCopyDir}/${f}`, "utf8"), f).toBe(fs.readFileSync(`${webCopyDir}/${f}`, "utf8"));
    }
  });
});

describe("web indicator exports", () => {
  it("are the shared implementations, not a separate copy", () => {
    for (const name of ["computeEMA", "computeRSI", "computeATR", "computeMACD", "computeBollingerBands", "computeVWAP", "computeCandleDelta", "prevPeriodHighLow"] as const) {
      expect(webIndicators[name]).toBe(shared[name]);
    }
  });
});
