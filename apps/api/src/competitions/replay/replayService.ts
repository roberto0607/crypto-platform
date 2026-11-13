/**
 * replayService.ts — DB read layer for match replay.
 *
 * Loads a completed match's trades (or the demo seed's match_positions) and
 * the price candles over the match, and builds each player's equity/P&L curve
 * on one clock (replayClock.ts): the match start, every candle close, every
 * fill, the match end. The candle size follows the match length (1m up to
 * 1h, 5m up to 6h, 1h beyond), falling back to coarser candles when the finer
 * ones are no longer stored (1m is kept 30 days).
 *
 * SOURCES, in order:
 *   1. match_positions: per-position rows with side, entry, exit and stored
 *      pnl. Only the demo seed writes them.
 *   2. fills: every real match. Each player's own trades on their
 *      match-scoped orders (match-end closes included), walked through the
 *      engine's position math with the fee the engine charged each one
 *      (fillReplay.ts), so the curve ends on the stored headline.
 * A match with neither (nobody traded) is a clear "no_replay_data".
 */
import { pool } from "../../db/pool.js";
import { computeFee, type FeeRole } from "../../trading/feeCalc.js";
import { getMatchById } from "../matchService.js";
import { fillTrips, reconstructFillCurve, type ReplayFill } from "./fillReplay.js";
import {
    reconstructPnlCurve,
    type NormalizedPosition,
    type CurvePoint,
} from "./reconstructPnlCurve.js";
import {
    TIMEFRAME_MS,
    candleWindow,
    replayClock,
    replayMarkPrice,
    timeframeFallbacks,
    type ReplayTimeframe,
} from "./replayClock.js";
import { logger } from "../../observability/logContext.js";

/** A timeframe is used when every traded pair has at least this share of its candles. */
const MIN_COVERAGE = 0.5;
/** A final point further than this from the stored headline (in percent) is logged. */
const HEADLINE_TOLERANCE_PCT = 1e-6;

export class ReplayError extends Error {
    constructor(public code: "match_not_found" | "no_replay_data" | "insufficient_candle_data") {
        super(code);
    }
}

export interface ReplayPosition {
    userId: string;
    pairSymbol: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    qty: number;
    exitPrice: number | null;
    openedAt: number;
    closedAt: number | null;
    pnl: number;
}

export interface ReplayCandle {
    ts: number;
    o: number;
    h: number;
    l: number;
    c: number;
}

export interface ReplayData {
    match: {
        id: string;
        startedAt: number | null;
        endedAt: number | null;
        startingCapital: number;
        challenger: { id: string; name: string; finalPnlPct: number | null };
        opponent: { id: string; name: string; finalPnlPct: number | null };
    };
    /** The size of the candles in `candles` (chosen from the match length). */
    candleTimeframe: ReplayTimeframe;
    candles: Record<string, ReplayCandle[]>;
    positions: ReplayPosition[];
    curves: Record<string, CurvePoint[]>;
    source: "match_positions" | "fills";
}

interface RawPosition {
    user_id: string;
    pair_id: string;
    symbol: string;
    side: "LONG" | "SHORT";
    entry_price: string;
    exit_price: string | null;
    qty: string;
    pnl: string | null;
    opened_at: Date;
    closed_at: Date | null;
}

type MatchRow = NonNullable<Awaited<ReturnType<typeof getMatchById>>>;

interface LoadedCandles {
    timeframe: ReplayTimeframe;
    bucketMs: number;
    byPairId: Map<string, ReplayCandle[]>;
}

/**
 * Candles for every traded pair over the match, at the size the match length
 * calls for. When that size isn't stored well enough (under MIN_COVERAGE of
 * its buckets for some pair: 1m ages out after 30 days, a feed gap), the next
 * coarser one is tried; failing all, the best-covered size any pair has data
 * for. No candles at all for a pair is insufficient_candle_data.
 */
async function loadCandles(pairIds: string[], startMs: number, endMs: number): Promise<LoadedCandles> {
    let best: { loaded: LoadedCandles; coverage: number } | null = null;
    for (const timeframe of timeframeFallbacks(endMs - startMs)) {
        const bucketMs = TIMEFRAME_MS[timeframe];
        const { from, to, buckets } = candleWindow(startMs, endMs, bucketMs);
        const { rows } = await pool.query<{
            pair_id: string; ts: Date; open: string; high: string; low: string; close: string;
        }>(
            `SELECT pair_id, ts, open, high, low, close
             FROM candles
             WHERE pair_id = ANY($1) AND timeframe = $2 AND ts >= $3 AND ts < $4
             ORDER BY ts ASC`,
            [pairIds, timeframe, new Date(from), new Date(to)],
        );
        const byPairId = new Map<string, ReplayCandle[]>(pairIds.map((pid) => [pid, []]));
        for (const r of rows) {
            byPairId.get(r.pair_id)!.push({
                ts: r.ts.getTime(), o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low), c: parseFloat(r.close),
            });
        }
        const coverage = Math.min(...pairIds.map((pid) => byPairId.get(pid)!.length / buckets));
        const loaded = { timeframe, bucketMs, byPairId };
        if (coverage >= MIN_COVERAGE) return loaded;
        if (coverage > 0 && (!best || coverage > best.coverage)) best = { loaded, coverage };
    }
    if (!best) throw new ReplayError("insufficient_candle_data");
    return best.loaded;
}

/** Candle closes inside the match, for the clock. */
function candleCloses(loaded: LoadedCandles): number[] {
    const out: number[] = [];
    for (const candles of loaded.byPairId.values()) for (const k of candles) out.push(k.ts + loaded.bucketMs);
    return out;
}

function candlesBySymbol(loaded: LoadedCandles, symbolByPairId: Map<string, string>): Record<string, ReplayCandle[]> {
    const out: Record<string, ReplayCandle[]> = {};
    for (const [pid, candles] of loaded.byPairId) out[symbolByPairId.get(pid)!] = candles;
    return out;
}

/**
 * The match end is the result the match recorded: the curve's last point is
 * the stored headline. The fills reach it on their own (oracle-tested); one
 * that doesn't (an ISOLATED loss capped at the margin, which the walk doesn't
 * model) is logged, and the end point still shows the recorded result.
 */
function endOnHeadline(
    curve: CurvePoint[], headlinePct: number | null, startingCapital: number, matchId: string, userId: string,
): CurvePoint[] {
    const last = curve.at(-1);
    if (!last || headlinePct == null) return curve;
    if (Math.abs(last.pnlPct - headlinePct) > HEADLINE_TOLERANCE_PCT) {
        logger.warn({ matchId, userId, replayPnlPct: last.pnlPct, headlinePnlPct: headlinePct }, "replay_headline_mismatch");
    }
    const equity = startingCapital + (startingCapital * headlinePct) / 100;
    curve[curve.length - 1] = {
        ts: last.ts, equity, pnlPct: headlinePct, realizedPnl: equity - startingCapital, unrealizedPnl: 0,
    };
    return curve;
}

function matchHeader(match: MatchRow, startingCapital: number): ReplayData["match"] {
    return {
        id: match.id,
        startedAt: match.started_at ? new Date(match.started_at).getTime() : null,
        endedAt: match.completed_at ? new Date(match.completed_at).getTime() : null,
        startingCapital,
        challenger: {
            id: match.challenger_id,
            name: match.challenger_name ?? "",
            finalPnlPct: match.challenger_pnl_pct != null ? parseFloat(match.challenger_pnl_pct) : null,
        },
        opponent: {
            id: match.opponent_id,
            name: match.opponent_name ?? "",
            finalPnlPct: match.opponent_pnl_pct != null ? parseFloat(match.opponent_pnl_pct) : null,
        },
    };
}

interface RawFill {
    user_id: string;
    pair_id: string;
    symbol: string;
    side: "BUY" | "SELL";
    price: string;
    qty: string;
    quote_amount: string;
    executed_at: Date;
    role: FeeRole;
    maker_fee_bps: number;
    taker_fee_bps: number;
    quote_asset_id: string;
}

/**
 * Both players' fills in the match: trades on their own match-scoped orders.
 * The taker is the order that arrived second (a resting order is always
 * older); a system fill (the book remainder, a match-end close) has only the
 * player's order, the taker. Within one order's fills (one executed_at), the
 * engine's sweep order: best price first.
 */
async function loadMatchFills(matchId: string, playerIds: string[]): Promise<RawFill[]> {
    const { rows } = await pool.query<RawFill>(
        `SELECT o.user_id, t.pair_id, tp.symbol, o.side, t.price::text, t.qty::text, t.quote_amount::text,
                t.executed_at,
                CASE WHEN other.id IS NULL OR other.created_at < o.created_at THEN 'TAKER' ELSE 'MAKER' END AS role,
                tp.maker_fee_bps, tp.taker_fee_bps, tp.quote_asset_id
           FROM orders o
           JOIN trades t ON t.buy_order_id = o.id OR t.sell_order_id = o.id
           JOIN trading_pairs tp ON tp.id = t.pair_id
           LEFT JOIN orders other
             ON other.id = CASE WHEN t.buy_order_id = o.id THEN t.sell_order_id ELSE t.buy_order_id END
          WHERE o.match_id = $1 AND o.user_id = ANY($2)
          ORDER BY t.executed_at, o.created_at, t.is_system_fill,
                   CASE WHEN (o.side = 'BUY') = (other.id IS NULL OR other.created_at < o.created_at)
                        THEN t.price END ASC,
                   t.price DESC`,
        [matchId, playerIds],
    );
    return rows;
}

/** The match's span: started → completed, widened to cover every event. */
function matchSpan(match: MatchRow, eventTimes: number[]): { startMs: number; endMs: number } {
    const first = Math.min(...eventTimes);
    const last = Math.max(...eventTimes);
    const started = match.started_at ? new Date(match.started_at).getTime() : first;
    const completed = match.completed_at ? new Date(match.completed_at).getTime() : last;
    return { startMs: Math.min(started, first), endMs: Math.max(completed, last) };
}

async function getFillReplay(match: MatchRow): Promise<ReplayData> {
    const players = [match.challenger_id, match.opponent_id];
    const raw = await loadMatchFills(match.id, players);
    if (raw.length === 0) throw new ReplayError("no_replay_data");

    const toFill = (r: RawFill): ReplayFill => ({
        pairId: r.pair_id,
        side: r.side,
        qty: r.qty,
        price: r.price,
        // The fee the engine charged this player on this fill.
        fee: computeFee(r.quote_amount, r.role, r, r.user_id).feeAmount,
        ts: r.executed_at.getTime(),
    });
    const allFills = raw.map(toFill);
    const fillsByUser = new Map(players.map((u) => [u, raw.filter((r) => r.user_id === u).map(toFill)]));

    const fillTimes = allFills.map((f) => f.ts);
    const { startMs, endMs } = matchSpan(match, fillTimes);
    const pairIds = [...new Set(raw.map((r) => r.pair_id))];
    const symbolByPairId = new Map(raw.map((r) => [r.pair_id, r.symbol]));
    const loaded = await loadCandles(pairIds, startMs, endMs);
    const clock = replayClock(startMs, endMs, candleCloses(loaded), fillTimes);
    const markPrice = replayMarkPrice(loaded.byPairId, loaded.bucketMs, allFills);
    const startingCapital = parseFloat(match.starting_capital);
    const header = matchHeader(match, startingCapital);
    const headline = new Map([[header.challenger.id, header.challenger.finalPnlPct], [header.opponent.id, header.opponent.finalPnlPct]]);

    const curves: Record<string, CurvePoint[]> = {};
    const positions: ReplayPosition[] = [];
    for (const userId of players) {
        const fills = fillsByUser.get(userId)!;
        curves[userId] = endOnHeadline(
            reconstructFillCurve(fills, clock, markPrice, startingCapital),
            headline.get(userId) ?? null, startingCapital, match.id, userId,
        );
        for (const trip of fillTrips(fills)) {
            positions.push({
                userId,
                pairSymbol: symbolByPairId.get(trip.pairId)!,
                side: trip.side,
                entryPrice: trip.entryPrice,
                qty: trip.qty,
                exitPrice: trip.exitPrice,
                openedAt: trip.openedAt,
                closedAt: trip.closedAt,
                pnl: trip.pnl,
            });
        }
    }
    positions.sort((a, b) => a.openedAt - b.openedAt);

    return {
        match: header,
        candleTimeframe: loaded.timeframe,
        candles: candlesBySymbol(loaded, symbolByPairId),
        positions,
        curves,
        source: "fills",
    };
}

export async function getMatchReplay(matchId: string): Promise<ReplayData> {
    const match = await getMatchById(matchId);
    if (!match) throw new ReplayError("match_not_found");

    const { rows: rawPositions } = await pool.query<RawPosition>(
        `SELECT mp.user_id, mp.pair_id, tp.symbol, mp.side,
                mp.entry_price, mp.exit_price, mp.qty, mp.pnl,
                mp.opened_at, mp.closed_at
         FROM match_positions mp
         JOIN trading_pairs tp ON tp.id = mp.pair_id
         WHERE mp.match_id = $1
         ORDER BY mp.opened_at ASC`,
        [matchId],
    );

    // A real match: no match_positions, replay its fills.
    if (rawPositions.length === 0) return getFillReplay(match);

    const eventTimes = rawPositions.flatMap((p) => [p.opened_at.getTime(), (p.closed_at ?? p.opened_at).getTime()]);
    const { startMs, endMs } = matchSpan(match, eventTimes);
    const pairIds = [...new Set(rawPositions.map((p) => p.pair_id))];
    const symbolByPairId = new Map(rawPositions.map((p) => [p.pair_id, p.symbol]));

    const loaded = await loadCandles(pairIds, startMs, endMs);
    const clock = replayClock(startMs, endMs, candleCloses(loaded), eventTimes);
    const markPrice = replayMarkPrice(loaded.byPairId, loaded.bucketMs, []);
    const startingCapital = parseFloat(match.starting_capital);

    // Reconstruct per player.
    const curves: Record<string, CurvePoint[]> = {};
    for (const userId of [match.challenger_id, match.opponent_id]) {
        const positions: NormalizedPosition[] = rawPositions
            .filter((p) => p.user_id === userId)
            .map((p) => ({
                pairId: p.pair_id,
                side: p.side,
                entryPrice: parseFloat(p.entry_price),
                qty: parseFloat(p.qty),
                openedAt: p.opened_at.getTime(),
                closedAt: (p.closed_at ?? p.opened_at).getTime(),
                realizedPnl: parseFloat(p.pnl ?? "0"),
            }));
        curves[userId] = reconstructPnlCurve(positions, clock, markPrice, startingCapital);
    }

    const positions: ReplayPosition[] = rawPositions.map((p) => ({
        userId: p.user_id,
        pairSymbol: p.symbol,
        side: p.side,
        entryPrice: parseFloat(p.entry_price),
        qty: parseFloat(p.qty),
        exitPrice: p.exit_price != null ? parseFloat(p.exit_price) : null,
        openedAt: p.opened_at.getTime(),
        closedAt: p.closed_at != null ? p.closed_at.getTime() : null,
        pnl: parseFloat(p.pnl ?? "0"),
    }));

    return {
        match: matchHeader(match, startingCapital),
        candleTimeframe: loaded.timeframe,
        candles: candlesBySymbol(loaded, symbolByPairId),
        positions,
        curves,
        source: "match_positions",
    };
}
