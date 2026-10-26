/**
 * What the order panel may offer a user on a pair (leverage PR 6a), as the
 * server will resolve it for their next order there. GET /leverage serves
 * it; the web never computes a cap itself.
 *
 *   marginMode   the model the next order trades (resolveTakerMargin: an
 *                open position's model, a match's stamp, the flag, system
 *                users). SPOT = today's path; the UI is unchanged.
 *   cap          the highest leverage an opening order may use (isolatedCap:
 *                flag, allowlist, per-mode cap, the match's stamp, the pair's
 *                max). 1 for SPOT and in an active solo replay on the pair.
 *   positionLeverage  the open ISOLATED position's leverage: an add must
 *                match it, so the selector locks to it. null when flat.
 *   blockedBy    a resting order of the other model on this pair/scope
 *                (spot_orders_open / isolated_orders_open): the next order
 *                is refused until it's canceled.
 */
import { pool } from "../db/pool";
import { config } from "../config";
import { timedQuery } from "../observability/dbTiming";
import {
    resolveTakerMargin,
    isolatedCap,
    pairRiskParams,
    readPosition,
    stateOf,
    type MarginMode,
    type PositionScope,
} from "./isolatedSettlement";

export type LeverageInfo = {
    enabled: boolean;
    marginMode: MarginMode;
    cap: number;
    mmrBps: number;
    positionLeverage: string | null;
    blockedBy: "spot_orders_open" | "isolated_orders_open" | null;
};

export async function getLeverageInfo(userId: string, pairId: string, scope: PositionScope): Promise<LeverageInfo> {
    const client = await pool.connect();
    try {
        const { rows: replay } = await timedQuery(client, "leverageInfo.replay",
            `SELECT 1 FROM replay_sessions WHERE user_id = $1 AND pair_id = $2 AND is_active = true`, [userId, pairId]);
        const inReplay = replay.length > 0;
        const { mmrBps } = await pairRiskParams(client, pairId);
        const base = { enabled: config.leverage.enabled, mmrBps };

        try {
            const m = await resolveTakerMargin(client, { userId, pairId, scope, replay: inReplay });
            if (m.mode === "SPOT") return { ...base, marginMode: "SPOT", cap: 1, positionLeverage: null, blockedBy: null };
            return {
                ...base,
                marginMode: "ISOLATED",
                cap: m.cap,
                positionLeverage: m.position.qty.isZero() ? null : m.position.leverage.toFixed(2),
                blockedBy: null,
            };
        } catch (err) {
            const code = err instanceof Error ? err.message : "";
            if (code === "isolated_orders_open") {
                return { ...base, marginMode: "SPOT", cap: 1, positionLeverage: null, blockedBy: code };
            }
            if (code !== "spot_orders_open") throw err;
            // The next order would trade ISOLATED; resting SPOT orders block it.
            const { cap } = await isolatedCap(client, userId, pairId, scope);
            const position = stateOf(await readPosition(client, userId, pairId, scope, false));
            return {
                ...base,
                marginMode: "ISOLATED",
                cap: inReplay ? 1 : cap,
                positionLeverage: position.qty.isZero() ? null : position.leverage.toFixed(2),
                blockedBy: code,
            };
        }
    } finally {
        client.release();
    }
}
