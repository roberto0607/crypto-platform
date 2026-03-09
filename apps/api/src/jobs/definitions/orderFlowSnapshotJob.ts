import type { JobDefinition } from "../jobTypes.js";
import { getAllOrderFlow } from "../../market/orderFlowFeatures.js";

/**
 * Saves order flow feature snapshots to PostgreSQL every 60 seconds.
 * These snapshots are used by the ML pipeline to train models with
 * order book features aligned to candle timeframes.
 */
export const orderFlowSnapshotJob: JobDefinition = {
    name: "order-flow-snapshot",
    intervalSeconds: 60,

    async run(ctx) {
        const features = getAllOrderFlow();
        if (features.size === 0) return;

        let inserted = 0;

        for (const [pairId, f] of features) {
            // Skip stale data (older than 2 minutes)
            if (Date.now() - f.ts > 120_000) continue;

            try {
                await ctx.pool.query(
                    `INSERT INTO order_flow_snapshots (
                        pair_id, ts,
                        bid_ask_imbalance, weighted_imbalance, top_level_imbalance,
                        bid_depth_usd, ask_depth_usd, depth_ratio, spread_bps,
                        large_order_bid, large_order_ask,
                        max_bid_size, max_ask_size,
                        bid_wall_price, ask_wall_price
                    ) VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                    [
                        pairId,
                        f.bidAskImbalance,
                        f.weightedImbalance,
                        f.topLevelImbalance,
                        f.bidDepthUsd,
                        f.askDepthUsd,
                        f.depthRatio,
                        f.spreadBps,
                        f.largeOrderBid,
                        f.largeOrderAsk,
                        f.maxBidSize,
                        f.maxAskSize,
                        f.bidWallPrice,
                        f.askWallPrice,
                    ],
                );
                inserted++;
            } catch (err) {
                ctx.logger.error({ err, pairId }, "order_flow_snapshot_insert_failed");
            }
        }

        if (inserted > 0) {
            ctx.logger.debug({ inserted }, "order_flow_snapshots_saved");
        }

        // Periodic cleanup: delete snapshots older than 7 days
        try {
            await ctx.pool.query(
                `DELETE FROM order_flow_snapshots WHERE ts < now() - interval '7 days'`,
            );
        } catch {
            // Non-critical
        }
    },
};
