import type { JobDefinition } from "../jobTypes";
import { pool } from "../../db/pool.js";
import {
    syncSymbols,
    checkDelistings,
    DEFAULT_SYNC_LIMIT,
} from "../../market/symbolSync.js";

/**
 * Periodic refresh of the Kraken ∩ Coinbase curated symbol universe — runs
 * every 6h (new listings aren't latency-sensitive, and both exchanges'
 * public endpoints rate-limit aggressively enough that hourly+ is prudent).
 *
 * Shares all discovery/ranking/upsert/delisting logic with the one-time
 * backfill script (scripts/backfillExchangeSymbols.ts) via
 * src/market/symbolSync.ts — no duplicated fetch/parse code.
 *
 * Two independent passes per run:
 *   1. syncSymbols — new pairs present on BOTH exchanges get upserted,
 *      wallets provisioned for existing users, then activated (same as the
 *      backfill script's --commit path).
 *   2. checkDelistings — pairs no longer listed/online on one exchange get
 *      that exchange's mapping row deactivated; trading_pairs.is_active
 *      only flips off once BOTH exchange rows are inactive (a pair delisted
 *      on one exchange but still live on the other keeps trading).
 */
export const symbolRefreshJob: JobDefinition = {
    name: "symbol-refresh",
    intervalSeconds: 21_600, // 6h
    timeoutMs: 60_000,
    maxRunSeconds: 90,
    async run(ctx) {
        const { results } = await syncSymbols(DEFAULT_SYNC_LIMIT);
        const added = results.filter((r) => r.isNewPair);
        for (const a of added) {
            ctx.logger.info({ symbol: a.ourSymbol, pairId: a.pairId }, "symbol_refresh_pair_added");
        }

        const client = await pool.connect();
        let delisting: Awaited<ReturnType<typeof checkDelistings>>;
        try {
            await client.query("BEGIN");
            delisting = await checkDelistings(client);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }

        if (added.length > 0 || delisting.exchangeRowsDeactivated > 0) {
            ctx.logger.info(
                {
                    pairsAdded: added.length,
                    exchangeRowsDeactivated: delisting.exchangeRowsDeactivated,
                    pairsDeactivated: delisting.pairsDeactivated,
                },
                "symbol_refresh_done",
            );
        }
    },
};
