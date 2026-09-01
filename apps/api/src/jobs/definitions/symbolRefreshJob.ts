import type { JobDefinition } from "../jobTypes";
import { pool } from "../../db/pool.js";
import {
    syncSymbols,
    checkDelistings,
    prunePairs,
} from "../../market/symbolSync.js";
import { config } from "../../config.js";

/**
 * Periodic refresh of the Kraken ∩ Coinbase curated symbol universe — runs
 * every 6h (new listings aren't latency-sensitive, and both exchanges'
 * public endpoints rate-limit aggressively enough that hourly+ is prudent).
 *
 * Shares all discovery/ranking/upsert/delisting logic with the one-time
 * backfill script (scripts/backfillExchangeSymbols.ts) via
 * src/market/symbolSync.ts — no duplicated fetch/parse code.
 *
 * Three passes per run:
 *   1. syncSymbols — new pairs present on BOTH exchanges get upserted,
 *      wallets provisioned for existing users, then activated (same as the
 *      backfill script's --commit path). A pair that already has a
 *      trading_pairs row but was previously deactivated (delisted, then
 *      relisted) gets is_active flipped back to true too — row-existence
 *      alone isn't enough to decide "already active".
 *   2. checkDelistings — pairs no longer listed/online on one exchange get
 *      that exchange's mapping row deactivated; trading_pairs.is_active
 *      only flips off once BOTH exchange rows are inactive (a pair delisted
 *      on one exchange but still live on the other keeps trading).
 *   3. prunePairs — grace-counter maintenance + safety-gated deactivation
 *      of pairs that have sat outside the top MARKET_CAP_RANK_CUTOFF for
 *      MCAP_PRUNE_GRACE_RUNS consecutive runs. Opt-in per environment via
 *      MCAP_PRUNE_ENABLED; skipped entirely when disabled.
 */
export const symbolRefreshJob: JobDefinition = {
    name: "symbol-refresh",
    intervalSeconds: 21_600, // 6h
    timeoutMs: 60_000,
    maxRunSeconds: 90,
    async run(ctx) {
        const { results } = await syncSymbols();
        const added = results.filter((r) => r.isNewPair);
        for (const a of added) {
            ctx.logger.info({ symbol: a.ourSymbol, pairId: a.pairId }, "symbol_refresh_pair_added");
        }
        const reactivated = results.filter((r) => r.wasReactivated);
        for (const r of reactivated) {
            ctx.logger.info({ symbol: r.ourSymbol, pairId: r.pairId }, "symbol_refresh_pair_reactivated");
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

        // Market-cap prune pass — opt-in per environment (config.mcapPruneEnabled).
        // Its own CoinGecko fetch + transaction. Throws (→ job FAILED) on a
        // CoinGecko outage or a Layer-B safety-assertion mismatch.
        let prune: Awaited<ReturnType<typeof prunePairs>> | null = null;
        if (config.mcapPruneEnabled) {
            prune = await prunePairs();
        }

        if (added.length > 0 || reactivated.length > 0 || delisting.exchangeRowsDeactivated > 0
            || (prune !== null && (prune.pairsDeactivated > 0 || prune.missesIncremented > 0 || prune.missesReset > 0))) {
            ctx.logger.info(
                {
                    pairsAdded: added.length,
                    pairsReactivated: reactivated.length,
                    exchangeRowsDeactivated: delisting.exchangeRowsDeactivated,
                    pairsDeactivated: delisting.pairsDeactivated,
                    mcapPruneEnabled: config.mcapPruneEnabled,
                    mcapPairsDeactivated: prune?.pairsDeactivated ?? 0,
                    mcapMissesIncremented: prune?.missesIncremented ?? 0,
                    mcapMissesReset: prune?.missesReset ?? 0,
                },
                "symbol_refresh_done",
            );
        }
    },
};
