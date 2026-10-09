/**
 * measureKrakenChecksum.ts — run the REAL Kraken feed module (src/market/
 * krakenWs.ts + krakenBook.ts) against Kraken's public WS v2 feed and report
 * how its order book fares against Kraken's CRC32 checksums.
 *
 * Nothing is reimplemented here: the feed connects, subscribes to every
 * active Kraken symbol in the (local) DB and verifies every book message
 * exactly as in production. Results are read back from the module's own
 * Prometheus counters (tradr_kraken_book_checksum_total, ..._resyncs_total)
 * and feed-health reconnect log.
 *
 *   Baseline (observe mode, 10 min):  tsx scripts/measureKrakenChecksum.ts
 *   Custom length:                    tsx scripts/measureKrakenChecksum.ts --minutes 2
 *   Corruption check:                 tsx scripts/measureKrakenChecksum.ts --minutes 1 --inject-at-sec 20 --enforce
 *
 * --inject-at-sec S  After S seconds, rewrite ONE incoming BTC/USD book update
 *                    on the wire, adding 1 to the last digit of one level's qty
 *                    (1 satoshi), before the feed module sees it — a misapplied
 *                    delta. Expect exactly one mismatch; with --enforce, also a
 *                    book-only resubscribe and a "recovered" fresh snapshot.
 * --enforce          KRAKEN_BOOK_CHECKSUM_ENFORCE=true for this run.
 *
 * Exit code 1 when an un-injected run sees any mismatch, or an injected run
 * does not catch the corruption (or, with --enforce, does not recover).
 *
 * Side effects: only what `pnpm dev`'s Kraken feed does (live Kraken-sourced
 * 1m candles flushed to the DB), minus the boot candle backfill and the
 * trading_pairs.last_price sync, which are switched off here. Refuses to run
 * against a non-local DATABASE_URL. No Redis (in-memory snapshot store).
 */
import "dotenv/config";
import WebSocket from "ws";
import client from "prom-client";
import { config } from "../src/config";
import { pool } from "../src/db/pool";
import { startKrakenFeed, stopKrakenFeed } from "../src/market/krakenWs";
import { getFeedHealthSnapshot } from "../src/observability/feedHealth";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}
const minutes = Number(arg("--minutes") ?? 10);
const injectAtSec = arg("--inject-at-sec") !== undefined ? Number(arg("--inject-at-sec")) : null;
const enforce = process.argv.includes("--enforce");
const INJECT_SYMBOL = "BTC/USD";

const dbHost = (() => {
    try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(dbHost)) {
    console.error(`Refusing to run: DATABASE_URL host "${dbHost}" is not local. This script is for local measurement only.`);
    process.exit(2);
}

config.krakenWsEnabled = true;
config.candleBackfillOnBoot = false;
config.lastPriceSyncIntervalMs = Number.POSITIVE_INFINITY;
config.krakenBookChecksumEnforce = enforce;

// ── Wire-level corruption: patch ws's emit so ONE book frame is altered before
// the feed module's "message" handler parses it.
const t0 = Date.now();
let injected: { atMs: number; level: string; from: string; to: string } | null = null;
if (injectAtSec !== null) {
    const origEmit = WebSocket.prototype.emit;
    WebSocket.prototype.emit = function (this: WebSocket, event: string | symbol, ...args: any[]) {
        if (event === "message" && !injected && Date.now() - t0 >= injectAtSec * 1000) {
            const text = args[0].toString();
            if (text.includes('"channel":"book"') && text.includes('"type":"update"') && text.includes(`"symbol":"${INJECT_SYMBOL}"`)) {
                const m = /"qty":(\d+)\.(\d+)/.exec(text);
                if (m && /[1-9]/.test(m[1]! + m[2]!)) {
                    const decimals = m[2]!.length;
                    const bumped = (BigInt(m[1]! + m[2]!) + 1n).toString().padStart(decimals + 1, "0");
                    const to = `${bumped.slice(0, -decimals)}.${bumped.slice(-decimals)}`;
                    const from = `${m[1]}.${m[2]}`;
                    args[0] = Buffer.from(text.slice(0, m.index) + `"qty":${to}` + text.slice(m.index + m[0].length));
                    injected = { atMs: Date.now() - t0, level: INJECT_SYMBOL, from, to };
                    console.error(`[measure] injected 1-unit qty corruption into ${INJECT_SYMBOL}: ${from} → ${to}`);
                }
            }
        }
        return origEmit.call(this, event, ...args);
    } as typeof origEmit;
}

type Counts = Record<string, Record<string, number>>; // label value → result/outcome → n
async function readCounter(name: string, key: string): Promise<{ total: Record<string, number>; bySymbol: Counts }> {
    const metric = await client.register.getSingleMetric(name)!.get();
    const total: Record<string, number> = {};
    const bySymbol: Counts = {};
    for (const v of metric.values) {
        const symbol = String(v.labels.symbol);
        const k = String(v.labels[key]);
        total[k] = (total[k] ?? 0) + v.value;
        (bySymbol[symbol] ??= {})[k] = v.value;
    }
    return { total, bySymbol };
}

async function report(final: boolean) {
    const checks = await readCounter("tradr_kraken_book_checksum_total", "result");
    const resyncs = await readCounter("tradr_kraken_book_resyncs_total", "outcome");
    const elapsedS = Math.round((Date.now() - t0) / 1000);
    if (!final) {
        console.error(`[measure ${elapsedS}s] ${JSON.stringify(checks.total)}`);
        return;
    }
    const mismatchSymbols = Object.fromEntries(
        Object.entries(checks.bySymbol).filter(([, r]) => (r.mismatch ?? 0) > 0),
    );
    const reconnects = getFeedHealthSnapshot().reconnects.kraken?.recent ?? [];
    const out = {
        node: process.version,
        durationS: elapsedS,
        enforce,
        symbolsSeen: Object.keys(checks.bySymbol).length,
        checks: checks.total,
        mismatchSymbols,
        resyncs: resyncs.bySymbol,
        injected,
        reconnects: reconnects.map((r) => ({ cause: r.cause, detail: r.detail })),
    };
    console.log(JSON.stringify(out, null, 2));

    const mismatches = checks.total.mismatch ?? 0;
    let ok: boolean;
    if (injectAtSec === null) {
        ok = mismatches === 0;
    } else {
        const caught = injected !== null && (mismatchSymbols[INJECT_SYMBOL]?.mismatch ?? 0) >= 1
            && Object.keys(mismatchSymbols).every((s) => s === INJECT_SYMBOL);
        const recovered = !enforce || (resyncs.bySymbol[INJECT_SYMBOL]?.recovered ?? 0) >= 1;
        ok = caught && recovered;
    }
    console.error(ok ? "[measure] PASS" : "[measure] FAIL");
    return ok;
}

startKrakenFeed();
const progress = setInterval(() => void report(false), 60_000);
setTimeout(async () => {
    clearInterval(progress);
    const ok = await report(true);
    stopKrakenFeed();
    await pool.end().catch(() => {});
    process.exit(ok ? 0 : 1);
}, minutes * 60_000);
