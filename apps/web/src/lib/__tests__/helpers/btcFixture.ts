/**
 * The committed real Coinbase BTC-USD fixture (packages/indicators/fixtures),
 * read with node:fs like sharedIndicatorsParity.test.ts does (web has no
 * @types/node, and Vite won't import JSON from outside apps/web).
 */
import { fixtureCandles, type Candle, type CandleFixture } from "@/lib/sharedIndicators";

const fsModule = "node:fs";
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: "utf8"): string };
const repoRoot = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "").replace(/\/apps\/web\/src\/.*$/, ""));

const fixture = JSON.parse(
    fs.readFileSync(`${repoRoot}/packages/indicators/fixtures/btcusd-coinbase.json`, "utf8"),
) as CandleFixture;

/** Closed candles of one fixture timeframe ("4h", "1d", "1w"), oldest first. */
export function btcCandles(tf: "4h" | "1d" | "1w"): Candle[] {
    return fixtureCandles(fixture.timeframes[tf]!);
}
