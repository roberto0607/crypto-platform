/**
 * Live-side open interest: Gate.io + OKX (Binance futures APIs are
 * geo-blocked from Railway). Both refuse history older than 180 days, so
 * they serve the live recorder and the OI overlap check, never the study.
 *
 * Timestamps (checked live 2026-11-17): each value is the OI AT its
 * timestamp. OKX's 1H and 1D values agree exactly at shared timestamps, and
 * OKX daily points fall at 16:00 UTC (00:00 Hong Kong); Gate.io daily
 * points are at 00:00 UTC, hourly on the hour.
 */
import type { Point } from "../../../indicators/shared";
import { defaultHttp, pause, type Http } from "./http";

const GATE_URL = "https://api.gateio.ws/api/v4/futures/usdt/contract_stats";
const OKX_URL = "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume";
const GATE_PAGE = 2_000;

/** Gate.io BTC_USDT hourly OI in USD over [from, toExclusive). */
export async function fetchGateOi(opts: { from: number; toExclusive: number; http?: Http; sleepMs?: number }): Promise<Point[]> {
  const http = opts.http ?? defaultHttp;
  const byTime = new Map<number, number>();
  let cursor = Math.ceil(opts.from / 3_600) * 3_600;
  while (cursor < opts.toExclusive) {
    const rows = (await http.json(`${GATE_URL}?contract=BTC_USDT&interval=1h&limit=${GATE_PAGE}&from=${cursor}`)) as Array<{ time: number; open_interest_usd: number }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    let last = cursor;
    for (const r of rows) {
      if (r.time >= opts.from && r.time < opts.toExclusive && Number.isFinite(r.open_interest_usd)) byTime.set(r.time, r.open_interest_usd);
      last = Math.max(last, r.time);
    }
    if (last + 3_600 <= cursor) break;
    cursor = last + 3_600;
    await pause(opts.sleepMs ?? 150);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

/** OKX BTC OI in USD (all contracts), 1H (~30 days back) or 1D (~180 days back), inside [from, toExclusive). */
export async function fetchOkxOi(opts: { period: "1H" | "1D"; from: number; toExclusive: number; http?: Http }): Promise<Point[]> {
  const http = opts.http ?? defaultHttp;
  const json = (await http.json(`${OKX_URL}?ccy=BTC&period=${opts.period}`)) as { data?: Array<[string, string, string]> };
  return (json.data ?? [])
    .map((r) => ({ time: Math.floor(Number(r[0]) / 1000), value: Number(r[1]) }))
    .filter((p) => Number.isFinite(p.value) && p.time >= opts.from && p.time < opts.toExclusive)
    .sort((a, b) => a.time - b.time);
}

/** Gate.io + OKX, only at timestamps both venues have. */
export function combineOi(gate: Point[], okx: Point[]): Point[] {
  const o = new Map(okx.map((p) => [p.time, p.value]));
  return gate.filter((p) => o.has(p.time)).map((p) => ({ time: p.time, value: p.value + o.get(p.time)! }));
}
