import { pool } from "../db/pool";
import { getSession } from "./replayRepo";
import { getSnapshot } from "../market/snapshotStore";
import { findPairById } from "../trading/pairRepo";
import type { Snapshot } from "../market/snapshotStore";

export async function getSnapshotForUser(userId: string, pairId: string): Promise<Snapshot> {
    //1. Check for active replay session
    const session = await getSession(userId, pairId);

    if (session && session.is_active) {
        //Derive snapshot from candle at current_ts
        const candle = await pool.query<{ close: string }>(
            `
            SELECT close
            FROM candles
            WHERE pair_id = $1 AND timeframe = $2 AND ts <= $3
            ORDER BY ts DESC
            LIMIT 1
            `,
            [pairId, session.timeframe, session.current_ts]
        );

        if (candle.rows.length > 0) {
            return {
                bid: null,
                ask: null,
                last: candle.rows[0].close,
                ts: session.current_ts,
                source: "replay",
            };
        }

        //No candle found - fall through to live/fallback
    }

    //2. Try live snapshot
    const pair = await findPairById(pairId);
    if (!pair) {
        return { bid: null, ask: null, last: "0", ts: new Date().toISOString(), source: "fallback" };
    }

    const live = getSnapshot(pair.symbol);
    if (live) return live;

    //3. Fallback to last_price
    return {
        bid: null,
        ask: null,
        last: pair.last_price ?? "0",
        ts: new Date().toISOString(),
        source: "fallback",
    };
}