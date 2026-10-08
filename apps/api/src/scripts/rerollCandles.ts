/**
 * rerollCandles.ts — one-time: re-derive frozen 5m/15m/1h/4h/1d/1w buckets
 * from the stored 1m rows and replace the ones that differ. Logic + safety
 * notes in market/rerollCandles.ts; runbook in docs/runbooks/reroll-candles.md.
 *
 * Run AFTER the rollup lookback fix is deployed (otherwise new buckets keep
 * freezing). Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm candles:reroll                         # DRY-RUN (default): per TF/symbol counts + samples
 *   pnpm candles:reroll --tf 5m,1h --symbols BTC/USD   # narrow it
 *   pnpm candles:reroll --ohlc-only             # leave volume-only differences alone
 *   pnpm candles:reroll --commit                # snapshot old rows to JSON, then apply (one transaction)
 *   pnpm candles:reroll --revert <snapshot.json>  # undo a --commit
 *
 * --commit writes candle-reroll-<timestamp>.json (every row it replaces,
 * old + new values, and every row it inserts) BEFORE writing anything.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { pool } from "../db/pool";
import { config } from "../config";
import { tradableSymbols } from "../market/marketSymbols";
import { planReroll, applyReroll, revertReroll, type RerollChange, type CandleValues } from "../market/rerollCandles";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const ohlcv = (v: CandleValues | null) => (v ? `${v.open}/${v.high}/${v.low}/${v.close} v${v.volume}` : "(missing)");

async function revert(file: string): Promise<void> {
    const snap = JSON.parse(readFileSync(file, "utf8")) as { changes: RerollChange[] };
    const r = await revertReroll(pool, snap.changes);
    console.log(`Reverted ${file}: restored ${r.restored}, deleted ${r.deleted} inserted row(s), `
        + `skipped ${r.skipped} (row changed since the re-roll — left as is).`);
}

async function main(): Promise<void> {
    const revertFile = arg("revert");
    if (revertFile) return revert(revertFile);

    const commit = process.argv.includes("--commit");
    const symbols = arg("symbols")?.split(",") ?? tradableSymbols(config.marketSymbols);
    const timeframes = arg("tf")?.split(",");
    const ohlcOnly = process.argv.includes("--ohlc-only");
    const plan = await planReroll({ pool, symbols, timeframes, ohlcOnly });

    console.log(`\n=== rerollCandles [${commit ? "COMMIT" : "DRY-RUN"}] at ${plan.nowIso} ===`);
    console.log(`symbols: ${symbols.join(", ")}${ohlcOnly ? "   (--ohlc-only: volume-only differences left alone)" : ""}`);
    console.log(`\n  ${"symbol".padEnd(10)}${"tf".padEnd(5)}${"checked".padStart(8)}${"incomplete".padStart(11)}`
        + `${"unchanged".padStart(10)}${"ohlc".padStart(7)}${"vol-only".padStart(10)}${"missing".padStart(9)}`);
    for (const s of plan.series) {
        console.log(`  ${s.symbol.padEnd(10)}${s.timeframe.padEnd(5)}${String(s.bucketsChecked).padStart(8)}`
            + `${String(s.incomplete).padStart(11)}${String(s.unchanged).padStart(10)}`
            + `${String(s.changed).padStart(7)}${String(s.volumeOnly).padStart(10)}${String(s.missing).padStart(9)}`);
    }
    console.log(`\n"incomplete" = 1m history doesn't cover every minute of the bucket (left alone).`);
    console.log(`"ohlc"       = stored open/high/low/close differ from the 1m re-roll (frozen buckets look like this).`);
    console.log(`"vol-only"   = only volume differs — typical of exchange-native rows vs the sum of their 1m rows.`);

    const changed = plan.changes.filter((c) => c.old);
    const ohlcChanged = plan.changes.filter((c) => c.kind === "ohlc");
    if (ohlcChanged.length > 0) {
        console.log(`\nsample OHLC changes (stored → re-rolled), up to 3 per series:`);
        const seen = new Map<string, number>();
        for (const c of ohlcChanged) {
            const k = `${c.symbol} ${c.timeframe}`;
            if ((seen.get(k) ?? 0) >= 3) continue;
            seen.set(k, (seen.get(k) ?? 0) + 1);
            console.log(`  ${k.padEnd(14)} ${c.ts}  ${ohlcv(c.old)}  →  ${ohlcv(c.new)}`);
        }
    }

    if (!commit) {
        console.log(`\nDRY-RUN — nothing written. ${plan.changes.length} row(s) would be written. Re-run with --commit to apply.`);
        return;
    }
    if (plan.changes.length === 0) {
        console.log(`\nNothing to re-roll.`);
        return;
    }

    const file = `candle-reroll-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ at: plan.nowIso, series: plan.series, changes: plan.changes }, null, 2));
    console.log(`\nSnapshot written first: ${file}`);

    const written = await applyReroll(pool, plan.changes);
    console.log(`\n=== done === wrote ${written} row(s) in one transaction `
        + `(${changed.length} replaced, ${plan.changes.length - changed.length} inserted).`);
    console.log(`Undo with: pnpm candles:reroll --revert ${file}`);
}

main()
    .catch((err) => {
        console.error("rerollCandles failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
