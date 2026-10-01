/**
 * backfillMarketHistory.ts — re-download candle history for MARKET_SYMBOLS
 * (default BTC/ETH/SOL) into a fresh database. See market/historyBackfill.ts
 * for source, depth and idempotency details.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *   pnpm backfill:history --dry-run           # print the plan + request count
 *   pnpm backfill:history                     # run (safe to re-run; resumes)
 *   pnpm backfill:history --symbols BTC-USD   # subset
 *   pnpm backfill:history --force             # refetch every window (fills gaps)
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { parseMarketSymbols } from "../config";
import { runHistoryBackfill } from "../market/historyBackfill";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const symbols = arg("symbols") ? parseMarketSymbols(arg("symbols")) : undefined;
    const dryRun = process.argv.includes("--dry-run");
    const force = process.argv.includes("--force");
    const log = (m: string) => console.log(`[backfill:history] ${m}`);

    const res = await runHistoryBackfill({ pool, symbols, dryRun, force, log });

    const { rows } = await pool.query<{ timeframe: string; n: string; oldest: Date; newest: Date }>(
        `SELECT c.timeframe, count(*)::text AS n, min(c.ts) AS oldest, max(c.ts) AS newest
         FROM candles c JOIN trading_pairs tp ON tp.id = c.pair_id
         WHERE tp.symbol = ANY($1)
         GROUP BY c.timeframe ORDER BY min(extract(epoch FROM c.ts))`,
        [[...(symbols ?? parseMarketSymbols(process.env.MARKET_SYMBOLS))]],
    );
    const { rows: size } = await pool.query<{ table_mb: string; db_mb: string }>(
        `SELECT round(pg_total_relation_size('candles') / 1048576.0, 1)::text AS table_mb,
                round(pg_database_size(current_database()) / 1048576.0, 1)::text AS db_mb`,
    );
    log(`${dryRun ? "planned" : "done"}: ${res.requests} requests in ${Math.round(res.durationMs / 1000)}s`);
    console.table(rows.map((r) => ({ tf: r.timeframe, rows: Number(r.n), oldest: r.oldest.toISOString(), newest: r.newest.toISOString() })));
    log(`candles table ${size[0]!.table_mb} MB · database ${size[0]!.db_mb} MB`);
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error("[backfill:history] failed:", err);
        await pool.end().catch(() => {});
        process.exitCode = 1;
    });
