import { pool } from "../db/pool";
import { getSession } from "./replayRepo";
import { getSnapshot } from "../market/snapshotStore";
import { findPairById } from "../trading/pairRepo";
import type { Snapshot } from "../market/snapshotStore";
import { generateMicroTicks } from "./tickGenerator";
import type { Tick, CandleInput } from "./tickGenerator";
import { publish } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { eventsPublishedTotal } from "../metrics";

export type ReplayTick = {
    bid: string;
    ask: string;
    last: string;
    ts: number;
    source: "REPLAY";
};

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

    const live = await getSnapshot(pair.symbol);
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

/**
 * Advance the replay loop for a user/pair session.
 *
 * Reads the current session, fetches the candle at current_ts,
 * generates deterministic micro-ticks, finds the tick matching
 * the advanced timestamp (based on speed), updates current_ts,
 * and returns the micro-tick snapshot.
 *
 * Returns null if no active session or no candle data.
 */
export async function advanceReplayLoop(
    userId: string,
    pairId: string
): Promise<ReplayTick | null> {
    const session = await getSession(userId, pairId);
    if (!session || !session.is_active || session.is_paused) return null;

    // Fetch candle at current_ts
    const candleResult = await pool.query<{
        pair_id: string;
        timeframe: string;
        ts: string;
        open: string;
        high: string;
        low: string;
        close: string;
    }>(
        `
        SELECT pair_id, timeframe, ts, open, high, low, close
        FROM candles
        WHERE pair_id = $1 AND timeframe = $2 AND ts <= $3
        ORDER BY ts DESC
        LIMIT 1
        `,
        [pairId, session.timeframe, session.current_ts]
    );

    if (candleResult.rows.length === 0) return null;

    const row = candleResult.rows[0];
    const candle: CandleInput = {
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        ts: row.ts,
    };

    // Generate deterministic micro-ticks for this candle
    const ticks = generateMicroTicks(candle, pairId, session.timeframe);

    // Current position in epoch ms
    const currentMs = new Date(session.current_ts).getTime();

    // Advance by one tick interval scaled by speed
    const tickIntervalMs = 250;
    const advanceMs = Math.round(tickIntervalMs * parseFloat(session.speed));
    const newMs = currentMs + advanceMs;

    // Find the tick closest to newMs (but not past end of ticks)
    let bestTick: Tick = ticks[0];
    for (const tick of ticks) {
        if (tick.ts <= newMs) {
            bestTick = tick;
        } else {
            break;
        }
    }

    // Update session current_ts
    const newTs = new Date(newMs).toISOString();
    await pool.query(
        `
        UPDATE replay_sessions
        SET current_ts = $3
        WHERE user_id = $1 AND pair_id = $2 AND is_active = true
        `,
        [userId, pairId, newTs]
    );

    // Emit replay.tick (fire-and-forget)
    try {
        publish(createEvent("replay.tick", {
            pairId,
            bid: bestTick.bid,
            ask: bestTick.ask,
            last: bestTick.last,
            sessionTs: bestTick.ts,
        }, { userId }));
        eventsPublishedTotal.inc({ type: "replay.tick" });
    } catch {
        // Events must never break replay
    }

    return {
        bid: bestTick.bid,
        ask: bestTick.ask,
        last: bestTick.last,
        ts: bestTick.ts,
        source: "REPLAY",
    };
}
