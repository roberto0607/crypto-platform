#!/usr/bin/env node
/**
 * Regenerates fixtures/btcusd-coinbase.json from Coinbase's public candles API
 * (no auth). Run once and commit the result; tests never hit the network.
 *
 *   node packages/indicators/scripts/fetchFixture.mjs
 *
 * Coinbase has no 4h or 1w granularity, so (like our own rollups) 4h is built
 * from 1h on 00/04/08/... UTC buckets and 1w from 1d on Monday 00:00 UTC
 * buckets. 1w uses the full daily history (from the 2015 listing) so EMA/SMA
 * 200 seed from the same first bar as TradingView's COINBASE:BTCUSD.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const END_SEC = Date.UTC(2026, 10, 9) / 1000; // 2026-11-09 00:00 UTC: every bar before it is closed
const DAILY_FROM_SEC = Date.UTC(2015, 6, 20) / 1000;
const DAILY_KEEP_FROM_SEC = Date.UTC(2024, 8, 1) / 1000;
const HOURLY_FROM_SEC = Date.UTC(2026, 1, 1) / 1000;
const DAY = 86_400;
const WEEK_ANCHOR = 4 * DAY; // 1970-01-05, a Monday

async function fetchRange(granularity, fromSec, toSec) {
  const out = new Map();
  const step = granularity * 300; // Coinbase returns at most 300 candles per call
  for (let start = fromSec; start < toSec; start += step) {
    const end = Math.min(start + step, toSec);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}` +
      `&start=${new Date(start * 1000).toISOString()}&end=${new Date((end - 1) * 1000).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "indicator-fixture-script" } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    // [time, low, high, open, close, volume], newest first
    for (const [t, l, h, o, c, v] of await res.json()) {
      if (t >= fromSec && t < toSec) out.set(t, [t, o, h, l, c, v]);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

function rollup(rows, bucketOf) {
  const buckets = new Map();
  for (const r of rows) {
    const b = bucketOf(r[0]);
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, [b, r[1], r[2], r[3], r[4], r[5]]);
    else {
      cur[2] = Math.max(cur[2], r[2]);
      cur[3] = Math.min(cur[3], r[3]);
      cur[4] = r[4];
      cur[5] += r[5];
    }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]);
}

const daily = await fetchRange(DAY, DAILY_FROM_SEC, END_SEC);
const hourly = await fetchRange(3600, HOURLY_FROM_SEC, END_SEC);
const timeframes = {
  "4h": rollup(hourly, (t) => Math.floor(t / 14_400) * 14_400),
  "1d": daily.filter((r) => r[0] >= DAILY_KEEP_FROM_SEC),
  "1w": rollup(daily, (t) => Math.floor((t - WEEK_ANCHOR) / (7 * DAY)) * 7 * DAY + WEEK_ANCHOR),
};
// Coinbase volumes carry float noise; 8 decimals is BTC precision.
for (const rows of Object.values(timeframes)) for (const r of rows) r[5] = Math.round(r[5] * 1e8) / 1e8;

const lines = [
  "{",
  `  "source": "Coinbase Exchange public candles, BTC-USD; 4h rolled up from 1h, 1w from 1d (Monday 00:00 UTC)",`,
  `  "columns": ["time", "open", "high", "low", "close", "volume"],`,
  `  "timeframes": {`,
  Object.entries(timeframes)
    .map(([tf, rows]) => `    "${tf}": [\n${rows.map((r) => `      ${JSON.stringify(r)}`).join(",\n")}\n    ]`)
    .join(",\n"),
  "  }",
  "}",
  "",
];
const path = fileURLToPath(new URL("../fixtures/btcusd-coinbase.json", import.meta.url));
writeFileSync(path, lines.join("\n"));
for (const [tf, rows] of Object.entries(timeframes)) {
  console.log(tf, rows.length, new Date(rows[0][0] * 1000).toISOString(), "→", new Date(rows.at(-1)[0] * 1000).toISOString());
}
