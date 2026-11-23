/**
 * Alternative.me Fear & Greed full history (daily, from 2018-02-01). The API
 * only serves "last N" or everything (`limit=0`), so callers clip to their
 * range after fetching. Point = (day 00:00 UTC, value 0–100). The features
 * use it with a one-day lag, since history doesn't record publish times.
 */
import type { Point } from "../../../indicators/shared";
import { defaultHttp, type Http } from "./http";

const URL_ALL = "https://api.alternative.me/fng/?limit=0";

export async function fetchFearGreedHistory(opts: { http?: Http } = {}): Promise<Point[]> {
  const http = opts.http ?? defaultHttp;
  const json = (await http.json(URL_ALL)) as { data?: Array<{ value: string; timestamp: string }> };
  return (json.data ?? [])
    .map((d) => ({ time: Number(d.timestamp), value: Number(d.value) }))
    .filter((p) => Number.isInteger(p.time) && Number.isFinite(p.value))
    .sort((a, b) => a.time - b.time);
}
