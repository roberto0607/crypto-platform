/**
 * Signal Tracker Job — checks pending ML signals for TP/SL hits.
 *
 * Runs every 30 seconds. For each pending signal:
 * 1. Gets current price from trading_pairs.last_price
 * 2. Checks if TP1/TP2/TP3 or SL has been hit
 * 3. Updates outcome + hit timestamps
 * 4. Expires signals past their expiry time
 *
 * Also triggers new signal fetch from the ML service periodically.
 */
import type { JobDefinition } from "../jobTypes";
import { fetchAndStoreSignal } from "../../market/signalService.js";
import { config } from "../../config.js";

export const signalTrackerJob: JobDefinition = {
    name: "signal-tracker",
    intervalSeconds: 30,
    timeoutMs: 15_000,

    async run({ pool, logger, signal }) {
        if (!config.mlPredictionEnabled) return;

        // ── 1. Track pending signals ──
        const { rows: pending } = await pool.query<{
            id: string;
            pair_id: string;
            signal_type: string;
            entry_price: string;
            tp1_price: string;
            tp2_price: string;
            tp3_price: string;
            stop_loss_price: string;
            tp1_hit_at: string | null;
            tp2_hit_at: string | null;
            tp3_hit_at: string | null;
            sl_hit_at: string | null;
            expires_at: string;
        }>(
            `SELECT s.id, s.pair_id, s.signal_type, s.entry_price,
                    s.tp1_price, s.tp2_price, s.tp3_price, s.stop_loss_price,
                    s.tp1_hit_at, s.tp2_hit_at, s.tp3_hit_at, s.sl_hit_at,
                    s.expires_at
             FROM ml_signals s
             WHERE s.outcome = 'pending'
             ORDER BY s.created_at DESC`,
        );

        const now = new Date();

        for (const sig of pending) {
            if (signal.aborted) break;

            // Check expiry
            if (new Date(sig.expires_at) < now) {
                await pool.query(
                    `UPDATE ml_signals SET outcome = 'expired', closed_at = now() WHERE id = $1`,
                    [sig.id],
                );
                logger.debug({ signalId: sig.id }, "signal_expired");
                continue;
            }

            // Get current price
            const { rows: priceRows } = await pool.query<{ last_price: string | null }>(
                `SELECT last_price FROM trading_pairs WHERE id = $1`,
                [sig.pair_id],
            );
            if (priceRows.length === 0 || !priceRows[0]!.last_price) continue;

            const currentPrice = Number(priceRows[0]!.last_price);
            const isBuy = sig.signal_type === "BUY";

            const tp1 = Number(sig.tp1_price);
            const tp2 = Number(sig.tp2_price);
            const tp3 = Number(sig.tp3_price);
            const sl = Number(sig.stop_loss_price);

            const updates: string[] = [];

            // Check TP1
            if (!sig.tp1_hit_at && ((isBuy && currentPrice >= tp1) || (!isBuy && currentPrice <= tp1))) {
                updates.push(`tp1_hit_at = now()`);
            }

            // Check TP2
            if (!sig.tp2_hit_at && ((isBuy && currentPrice >= tp2) || (!isBuy && currentPrice <= tp2))) {
                updates.push(`tp2_hit_at = now()`);
            }

            // Check TP3
            if (!sig.tp3_hit_at && ((isBuy && currentPrice >= tp3) || (!isBuy && currentPrice <= tp3))) {
                updates.push(`tp3_hit_at = now()`);
            }

            // Check SL
            if (!sig.sl_hit_at && ((isBuy && currentPrice <= sl) || (!isBuy && currentPrice >= sl))) {
                updates.push(`sl_hit_at = now()`);
                updates.push(`outcome = 'sl'`);
                updates.push(`closed_at = now()`);
            }

            // Determine best outcome if not SL
            if (!updates.some((u) => u.includes("outcome"))) {
                // Check if TP3 just hit → close as tp3
                if (!sig.tp3_hit_at && ((isBuy && currentPrice >= tp3) || (!isBuy && currentPrice <= tp3))) {
                    updates.push(`outcome = 'tp3'`);
                    updates.push(`closed_at = now()`);
                }
                // TP2 hit but not closed yet? Keep pending, let it ride to TP3
                // TP1 hit but not closed yet? Keep pending, let it ride
            }

            if (updates.length > 0) {
                await pool.query(
                    `UPDATE ml_signals SET ${updates.join(", ")} WHERE id = $1`,
                    [sig.id],
                );
                logger.debug(
                    { signalId: sig.id, updates: updates.length, currentPrice },
                    "signal_updated",
                );
            }
        }

        // ── 2. Fetch new signals from ML service ──
        const { rows: pairs } = await pool.query<{ id: string; symbol: string }>(
            `SELECT id, symbol FROM trading_pairs WHERE is_active = true`,
        );

        for (const pair of pairs) {
            if (signal.aborted) break;

            try {
                await fetchAndStoreSignal(pair.id, pair.symbol, "1h");
            } catch (err) {
                logger.warn(
                    { pair: pair.symbol, err: (err as Error).message },
                    "ml_signal_fetch_failed",
                );
            }
        }
    },
};
