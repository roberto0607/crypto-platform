import type { JobDefinition } from "../jobTypes.js";
import { BINANCE_PAIR_MAP } from "../../market/binanceFutures.js";
import { pollDerivativesForPair, getAllDerivatives } from "../../market/derivativesPoller.js";
import { config } from "../../config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const derivativesPollerJob: JobDefinition = {
    name: "derivatives-poller",
    intervalSeconds: 60,

    async run(ctx) {
        if (!config.derivativesPollerEnabled) return;

        // Load pair symbol → ID mapping
        const { rows: pairs } = await ctx.pool.query<{ id: string; symbol: string }>(
            `SELECT id, symbol FROM trading_pairs WHERE is_active = true`,
        );

        const symbolToId: Record<string, string> = {};
        for (const p of pairs) {
            symbolToId[p.symbol] = p.id;
        }

        // Poll each pair from Binance
        for (const [ourSymbol] of Object.entries(BINANCE_PAIR_MAP)) {
            const pairId = symbolToId[ourSymbol];
            if (!pairId) continue;

            try {
                await pollDerivativesForPair(pairId, ourSymbol);
            } catch (err) {
                ctx.logger.error({ err, pairId, ourSymbol }, "derivatives_poll_failed");
            }

            await sleep(500); // Stagger requests
        }

        // Persist to DB
        const snapshots = getAllDerivatives();
        let inserted = 0;

        for (const [pairId, s] of snapshots) {
            if (Date.now() - s.ts > 120_000) continue; // Skip stale

            try {
                await ctx.pool.query(
                    `INSERT INTO derivatives_snapshots (
                        pair_id, ts,
                        funding_rate, funding_time, mark_price,
                        open_interest, open_interest_usd, oi_change_pct,
                        global_ls_ratio, global_long_pct, global_short_pct,
                        top_ls_ratio, top_long_pct, top_short_pct,
                        liq_pressure, liq_intensity
                    ) VALUES (
                        $1, now(),
                        $2, $3, $4,
                        $5, $6, $7,
                        $8, $9, $10,
                        $11, $12, $13,
                        $14, $15
                    )`,
                    [
                        pairId,
                        s.fundingRate,
                        s.fundingTime > 0 ? new Date(s.fundingTime) : null,
                        s.markPrice,
                        s.openInterest,
                        s.openInterestUsd,
                        s.oiChangePct,
                        s.globalLsRatio,
                        s.globalLongPct,
                        s.globalShortPct,
                        s.topLsRatio,
                        s.topLongPct,
                        s.topShortPct,
                        s.liqPressure,
                        s.liqIntensity,
                    ],
                );
                inserted++;
            } catch (err) {
                ctx.logger.error({ err, pairId }, "derivatives_snapshot_insert_failed");
            }
        }

        if (inserted > 0) {
            ctx.logger.info({ inserted }, "derivatives_snapshots_saved");
        }

        // Cleanup: delete rows older than 7 days
        try {
            await ctx.pool.query(
                `DELETE FROM derivatives_snapshots WHERE ts < now() - interval '7 days'`,
            );
        } catch {
            // Non-critical
        }
    },
};
