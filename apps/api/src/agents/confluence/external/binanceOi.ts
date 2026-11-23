/**
 * Binance USDⓈ-M futures open interest history from the public archive
 * (data.binance.vision, static files, reachable from the US), for the
 * factor study's history. One zip per UTC day with 5-minute rows from
 * 2020-09-01; each file has a published SHA-256 (.CHECKSUM) that we verify.
 *
 * Point = (create_time, sum_open_interest_value): OI in USD at that instant.
 * The files repeat every row twice (identical copies), so rows are deduped
 * by time.
 */
import { createHash } from "node:crypto";
import type { Point } from "../../../indicators/shared";
import { HttpNotFound, pause, type Http, defaultHttp } from "./http";
import { readSingleZipEntry } from "./zipReader";

export const BINANCE_ARCHIVE_START = "2020-09-01";
const BASE = "https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT";

export function verifyChecksum(zip: Buffer, checksumFile: string, fileName: string): void {
  const [hash, name] = checksumFile.trim().split(/\s+/);
  if (!hash || name !== fileName) throw new Error(`bad checksum file for ${fileName}`);
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== hash.toLowerCase()) throw new Error(`checksum mismatch for ${fileName}`);
}

export function parseBinanceMetricsCsv(csv: string): Point[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()?.split(",") ?? [];
  const iTime = header.indexOf("create_time");
  const iValue = header.indexOf("sum_open_interest_value");
  if (iTime < 0 || iValue < 0) throw new Error("unexpected Binance metrics header");
  const byTime = new Map<number, number>();
  for (const line of lines) {
    const cols = line.split(",");
    const t = Date.parse(`${cols[iTime]!.replace(" ", "T")}Z`) / 1000;
    const v = Number(cols[iValue]);
    if (Number.isFinite(t) && Number.isFinite(v) && v > 0) byTime.set(t, v);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

const dayList = (fromDay: string, toDayExclusive: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t < Date.parse(`${toDayExclusive}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

/** Days in [fromDay, toDayExclusive), never before the archive's first day. */
export async function fetchBinanceOiDays(opts: {
  fromDay: string;
  toDayExclusive: string;
  http?: Http;
  sleepMs?: number;
  onDay?: (day: string, n: number) => void;
}): Promise<{ points: Point[]; missingDays: string[] }> {
  const http = opts.http ?? defaultHttp;
  const fromDay = opts.fromDay < BINANCE_ARCHIVE_START ? BINANCE_ARCHIVE_START : opts.fromDay;
  const points: Point[] = [];
  const missingDays: string[] = [];
  for (const day of dayList(fromDay, opts.toDayExclusive)) {
    const file = `BTCUSDT-metrics-${day}.zip`;
    try {
      const zip = await http.buffer(`${BASE}/${file}`);
      const checksum = (await http.buffer(`${BASE}/${file}.CHECKSUM`)).toString("utf8");
      verifyChecksum(zip, checksum, file);
      const pts = parseBinanceMetricsCsv(readSingleZipEntry(zip).data.toString("utf8"));
      points.push(...pts);
      opts.onDay?.(day, pts.length);
    } catch (err) {
      if (err instanceof HttpNotFound) missingDays.push(day);
      else throw err;
    }
    await pause(opts.sleepMs ?? 100);
  }
  return { points, missingDays };
}
