/**
 * External-source clients against a fake HTTP layer, plus the real Binance
 * archive format (a checked-in day file, 2020-09-01, with its CHECKSUM).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readSingleZipEntry } from "../zipReader";
import { makeZip } from "./zipFixture";
import { parseBinanceMetricsCsv, fetchBinanceOiDays, verifyChecksum } from "../binanceOi";
import { fetchDeribitFunding } from "../deribitFunding";
import { fetchGateOi, fetchOkxOi, combineOi } from "../gateOkxOi";
import { fetchFearGreedHistory } from "../fearGreedHistory";
import { HttpNotFound, type Http } from "../http";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const utc = (iso: string) => Date.parse(iso) / 1000;

describe("readSingleZipEntry", () => {
  it("reads a deflated and a stored entry", () => {
    const text = Buffer.from("a,b\n1,2\n".repeat(50));
    expect(readSingleZipEntry(makeZip("x.csv", text, 8))).toEqual({ name: "x.csv", data: text });
    expect(readSingleZipEntry(makeZip("y.csv", text, 0))).toEqual({ name: "y.csv", data: text });
  });

  it("rejects something that isn't a zip", () => {
    expect(() => readSingleZipEntry(Buffer.from("not a zip at all, definitely not"))).toThrow(/zip/);
  });

  it("reads the real Binance archive file", () => {
    const { name, data } = readSingleZipEntry(fixture("BTCUSDT-metrics-2020-09-01.zip"));
    expect(name).toBe("BTCUSDT-metrics-2020-09-01.csv");
    expect(data.length).toBe(61_235);
  });
});

describe("Binance OI archive", () => {
  const zip = fixture("BTCUSDT-metrics-2020-09-01.zip");
  const checksum = fixture("BTCUSDT-metrics-2020-09-01.zip.CHECKSUM").toString("utf8");

  it("verifies the published SHA-256 and refuses a tampered file", () => {
    expect(() => verifyChecksum(zip, checksum, "BTCUSDT-metrics-2020-09-01.zip")).not.toThrow();
    const bad = Buffer.from(zip);
    bad[100] = bad[100]! ^ 0xff;
    expect(() => verifyChecksum(bad, checksum, "BTCUSDT-metrics-2020-09-01.zip")).toThrow(/checksum/);
  });

  it("parses the 5-minute OI in USD, dropping the file's exact duplicate rows", () => {
    const pts = parseBinanceMetricsCsv(readSingleZipEntry(zip).data.toString("utf8"));
    expect(pts).toHaveLength(288);
    expect(pts[0]).toEqual({ time: utc("2020-09-01T00:00:00Z"), value: 456_144_339.233_604_43 });
    expect(pts[287]!.time).toBe(utc("2020-09-01T23:55:00Z"));
    expect(pts.find((p) => p.time === utc("2020-09-01T00:55:00Z"))!.value).toBeCloseTo(445_816_462.638_682_88, 4);
  });

  it("fetches each day with its checksum and skips a day the archive doesn't have", async () => {
    const urls: string[] = [];
    const http: Http = {
      json: async () => { throw new Error("unused"); },
      buffer: async (url) => {
        urls.push(url);
        if (url.includes("2020-09-02")) throw new HttpNotFound(url);
        if (url.endsWith(".CHECKSUM")) return Buffer.from(checksum);
        return zip;
      },
    };
    const r = await fetchBinanceOiDays({ fromDay: "2020-09-01", toDayExclusive: "2020-09-03", http });
    expect(r.points).toHaveLength(288);
    expect(r.missingDays).toEqual(["2020-09-02"]);
    expect(urls[0]).toBe("https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2020-09-01.zip");
  });
});

describe("Deribit funding", () => {
  it("pages 30-day windows over [from, to) and keeps interest_8h per hour", async () => {
    const calls: Array<[number, number]> = [];
    const http: Http = {
      buffer: async () => Buffer.alloc(0),
      json: async (url) => {
        const q = new URL(url).searchParams;
        expect(q.get("instrument_name")).toBe("BTC-PERPETUAL");
        const s = Number(q.get("start_timestamp"));
        const e = Number(q.get("end_timestamp"));
        calls.push([s, e]);
        const result = [];
        for (let t = s; t <= e; t += 3_600_000) result.push({ timestamp: t, interest_8h: t / 1e15, interest_1h: 0, index_price: 1 });
        return { result };
      },
    };
    const from = utc("2019-01-01T00:00:00Z");
    const to = utc("2019-03-01T00:00:00Z");
    const pts = await fetchDeribitFunding({ from, toExclusive: to, http, sleepMs: 0 });
    expect(calls.length).toBe(2);
    for (const [s, e] of calls) expect(e - s).toBeLessThanOrEqual(30 * 86_400_000);
    expect(pts[0]).toEqual({ time: from, value: (from * 1000) / 1e15 });
    expect(pts[pts.length - 1]!.time).toBe(to - 3_600);
    expect(new Set(pts.map((p) => p.time)).size).toBe(pts.length);
  });
});

describe("Gate.io + OKX open interest", () => {
  it("Gate: pages hourly stats forward (≤ 2,000 a request), USD OI", async () => {
    const from = utc("2026-06-01T00:00:00Z");
    const to = from + 3_000 * 3_600;
    const http: Http = {
      buffer: async () => Buffer.alloc(0),
      json: async (url) => {
        const q = new URL(url).searchParams;
        expect(q.get("interval")).toBe("1h");
        const s = Number(q.get("from"));
        const n = Number(q.get("limit"));
        expect(n).toBeLessThanOrEqual(2_000);
        return Array.from({ length: n }, (_, i) => ({ time: s + i * 3_600, open_interest_usd: 1e9 + i })).filter((r) => r.time < to + 7_200);
      },
    };
    const pts = await fetchGateOi({ from, toExclusive: to, http, sleepMs: 0 });
    expect(pts).toHaveLength(3_000);
    expect(pts[0]).toEqual({ time: from, value: 1e9 });
  });

  it("OKX: [ts ms, oiUsd, volUsd] rows, ascending, inside the range", async () => {
    const http: Http = {
      buffer: async () => Buffer.alloc(0),
      json: async (url) => {
        expect(new URL(url).searchParams.get("period")).toBe("1D");
        return { code: "0", data: [["1794931200000", "2949807605.84", "1"], ["1794844800000", "2986377872.92", "1"], ["1700000000000", "1", "1"]] };
      },
    };
    expect(await fetchOkxOi({ period: "1D", from: 1_790_000_000, toExclusive: 1_800_000_000, http })).toEqual([
      { time: 1_794_844_800, value: 2_986_377_872.92 },
      { time: 1_794_931_200, value: 2_949_807_605.84 },
    ]);
  });

  it("sums the two venues only at timestamps both have", () => {
    expect(combineOi([{ time: 1, value: 10 }, { time: 2, value: 20 }], [{ time: 2, value: 5 }, { time: 3, value: 7 }])).toEqual([{ time: 2, value: 25 }]);
  });
});

describe("Fear & Greed history", () => {
  it("reads the full daily history, ascending", async () => {
    const http: Http = {
      buffer: async () => Buffer.alloc(0),
      json: async (url) => {
        expect(url).toContain("limit=0");
        return { data: [{ value: "10", timestamp: "1794787200" }, { value: "30", timestamp: "1517443200" }, { value: "x", timestamp: "1517529600" }] };
      },
    };
    expect(await fetchFearGreedHistory({ http })).toEqual([
      { time: 1_517_443_200, value: 30 },
      { time: 1_794_787_200, value: 10 },
    ]);
  });
});
