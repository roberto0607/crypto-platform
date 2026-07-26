import { pool } from "../db/pool";
import { subscribeGlobal, unsubscribe, publish } from "../events/eventBus";
import type { EventHandler } from "../events/eventBus";
import { createEvent } from "../events/eventTypes";
import { getSnapshot } from "../market/snapshotStore";
import { computeLiveMatchPnl, type LivePositionRow } from "./matchService";
import { logger as rootLogger } from "../observability/logContext";

const logger = rootLogger.child({ module: "matchPnlEngine" });

let handler: EventHandler | null = null;

// ── Publish gate ──
// Two gates, both reused from existing codebase conventions rather than
// invented fresh: 0.01 percentage points is the exact minDelta
// usePnlFlash.ts already uses client-side to decide "is this PnL change
// worth flashing" (kept in sync so the server's publish gate and the
// client's flash-worthiness threshold agree). 1000ms mirrors
// LIVE_INDICATOR_THROTTLE_MS, the established "recompute on tick, throttle
// to ~1/sec" convention CandlestickChart.tsx already uses for RSI/MACD/ATR
// live-update.
const MIN_PNL_DELTA_PCT = 0.01;
const MIN_PUBLISH_INTERVAL_MS = 1000;

interface LastPublished {
    at: number;
    challengerPnlPct: number;
    opponentPnlPct: number;
}

const lastPublishedByMatch = new Map<string, LastPublished>();

function shouldPublish(matchId: string, challengerPnlPct: number, opponentPnlPct: number): boolean {
    const last = lastPublishedByMatch.get(matchId);
    if (!last) return true;

    const now = Date.now();
    if (now - last.at < MIN_PUBLISH_INTERVAL_MS) return false;

    const challengerDelta = Math.abs(challengerPnlPct - last.challengerPnlPct);
    const opponentDelta = Math.abs(opponentPnlPct - last.opponentPnlPct);
    return challengerDelta >= MIN_PNL_DELTA_PCT || opponentDelta >= MIN_PNL_DELTA_PCT;
}

function recordPublished(matchId: string, challengerPnlPct: number, opponentPnlPct: number): void {
    lastPublishedByMatch.set(matchId, { at: Date.now(), challengerPnlPct, opponentPnlPct });
}

// ── Core recompute ──

interface ActiveMatchRef {
    id: string;
    challenger_id: string;
    opponent_id: string;
    starting_capital: string;
}

interface PositionRow {
    user_id: string;
    pair_id: string;
    base_qty: string;
    avg_entry_price: string;
    realized_pnl_quote: string | null;
    fees_paid_quote: string | null;
}

function toLiveRow(row: PositionRow): LivePositionRow {
    return {
        pairId: row.pair_id,
        baseQty: row.base_qty,
        avgEntryPrice: row.avg_entry_price,
        realizedPnlQuote: row.realized_pnl_quote ?? "0",
        feesPaidQuote: row.fees_paid_quote ?? "0",
    };
}

/**
 * Recompute and (if the publish gate passes) push live PnL for one match.
 * Pulls every position row the two participants hold in this match (not
 * just the pair that ticked) since a player's total match PnL sums across
 * every pair they've traded in the match.
 */
async function recomputeAndPublish(match: ActiveMatchRef): Promise<void> {
    const startingCapital = parseFloat(match.starting_capital);

    const { rows: positions } = await pool.query<PositionRow>(
        `SELECT user_id, pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote
         FROM positions
         WHERE match_id = $1`,
        [match.id],
    );

    const openPairIds = [...new Set(
        positions.filter((p) => parseFloat(p.base_qty) !== 0).map((p) => p.pair_id),
    )];

    const priceByPair = new Map<string, number>();
    if (openPairIds.length > 0) {
        const { rows: pairRows } = await pool.query<{ id: string; symbol: string; last_price: string | null }>(
            `SELECT id, symbol, last_price FROM trading_pairs WHERE id = ANY($1::uuid[])`,
            [openPairIds],
        );
        for (const pair of pairRows) {
            // Live snapshot first (<60s, same staleness window
            // closeMatchScopedPositions's exit-price fallback uses), then
            // trading_pairs.last_price. A pair with neither is left out of
            // priceByPair entirely -- computeLiveMatchPnl treats a missing
            // price as "skip this row's unrealized leg," not a hard failure.
            const snap = await getSnapshot(pair.symbol, 60_000);
            const snapPrice = snap ? parseFloat(snap.last) : NaN;
            if (Number.isFinite(snapPrice) && snapPrice > 0) {
                priceByPair.set(pair.id, snapPrice);
                continue;
            }
            const lastPrice = pair.last_price ? parseFloat(pair.last_price) : NaN;
            if (Number.isFinite(lastPrice) && lastPrice > 0) {
                priceByPair.set(pair.id, lastPrice);
            }
        }
    }

    const challengerRows = positions.filter((p) => p.user_id === match.challenger_id).map(toLiveRow);
    const opponentRows = positions.filter((p) => p.user_id === match.opponent_id).map(toLiveRow);

    const challengerPnlPct = computeLiveMatchPnl(challengerRows, priceByPair, startingCapital);
    const opponentPnlPct = computeLiveMatchPnl(opponentRows, priceByPair, startingCapital);

    if (!shouldPublish(match.id, challengerPnlPct, opponentPnlPct)) return;
    recordPublished(match.id, challengerPnlPct, opponentPnlPct);

    const data = {
        matchId: match.id,
        challengerPnlPct: challengerPnlPct.toFixed(8),
        opponentPnlPct: opponentPnlPct.toFixed(8),
    };

    publish(createEvent("match.pnl.update", data, { userId: match.challenger_id }));
    publish(createEvent("match.pnl.update", data, { userId: match.opponent_id }));
}

/**
 * Find every ACTIVE match with an open (base_qty != 0) position on this
 * pair, then recompute + publish for each. Live DB query per tick rather
 * than an in-memory index (alertEngine.ts's style) -- deliberate departure,
 * matching triggerEngine.ts's precedent instead. Match volume is tiny
 * today, and idx_positions_user_match_open (migration 066) is already a
 * partial index bounded by "currently-open match-scoped positions
 * platform-wide," so this join stays cheap without an index invalidation
 * story to maintain.
 */
export async function evaluateMatchPnlForPair(pairId: string): Promise<void> {
    const { rows: matches } = await pool.query<ActiveMatchRef>(
        `SELECT DISTINCT m.id, m.challenger_id, m.opponent_id, m.starting_capital
         FROM positions p
         JOIN matches m ON m.id = p.match_id
         WHERE p.pair_id = $1 AND p.base_qty <> 0 AND p.match_id IS NOT NULL AND m.status = 'ACTIVE'`,
        [pairId],
    );

    for (const match of matches) {
        await recomputeAndPublish(match).catch((err) => {
            logger.error({ matchId: match.id, pairId, err }, "match_pnl_recompute_error");
        });
    }
}

/**
 * Bootstrap: subscribe to price.tick (recompute) and match.ended (cache
 * cleanup, so lastPublishedByMatch doesn't grow unbounded over the life of
 * the process).
 */
export async function startMatchPnlEngine(): Promise<void> {
    if (handler) return; // already started

    handler = (event) => {
        if (event.type === "price.tick") {
            const { pairId } = event.data;
            evaluateMatchPnlForPair(pairId).catch((err) => {
                logger.error({ pairId, err }, "match_pnl_eval_error");
            });
        } else if (event.type === "match.ended") {
            lastPublishedByMatch.delete(event.data.matchId);
        }
    };

    subscribeGlobal(handler);
    logger.info("Match PnL engine started");
}

/**
 * Teardown: unsubscribe from event bus, clear the publish-gate cache.
 */
export function stopMatchPnlEngine(): void {
    if (handler) {
        unsubscribe(handler);
        handler = null;
    }
    lastPublishedByMatch.clear();
    logger.info("Match PnL engine stopped");
}
