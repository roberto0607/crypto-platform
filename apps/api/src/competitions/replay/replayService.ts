/**
 * replayService.ts — DB read layer for match replay.
 *
 * Loads a completed match's positions + 5m candle window and runs
 * reconstructPnlCurve per player into a per-candle equity/P&L curve.
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
    type MarkPriceLookup,
} from "./reconstructPnlCurve.js";

const HOUR_MS = 3_600_000;
const CANDLE_MS = 300_000; // 5m
const WINDOW_PAD_MS = HOUR_MS; // ±1h padding, matching the PR1 candle backfill

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

/** Build a forward-filling markPrice lookup over per-pair ascending [ts, close]. */
function buildMarkPrice(byPair: Map<string, ReplayCandle[]>): MarkPriceLookup {
    return (pairId, ts) => {
        const series = byPair.get(pairId);
        if (!series || series.length === 0) return null;
        // Binary search: last candle with ts <= T.
        let lo = 0;
        let hi = series.length - 1;
        let idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (series[mid]!.ts <= ts) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return idx === -1 ? null : series[idx]!.c;
    };
}

type MatchRow = NonNullable<Awaited<ReturnType<typeof getMatchById>>>;

/** 5m candles per traded pair over [start, end], every pair covered or insufficient_candle_data. */
async function loadCandles(
    pairIds: string[],
    windowStart: Date,
    windowEnd: Date,
): Promise<{ byPairId: Map<string, ReplayCandle[]>; times: number[] }> {
    const { rows: rawCandles } = await pool.query<{
        pair_id: string; ts: Date; open: string; high: string; low: string; close: string;
    }>(
        `SELECT pair_id, ts, open, high, low, close
         FROM candles
         WHERE pair_id = ANY($1) AND timeframe = '5m' AND ts >= $2 AND ts <= $3
         ORDER BY ts ASC`,
        [pairIds, windowStart, windowEnd],
    );
    const byPairId = new Map<string, ReplayCandle[]>();
    for (const pid of pairIds) byPairId.set(pid, []);
    const allTimes = new Set<number>();
    for (const r of rawCandles) {
        const ts = r.ts.getTime();
        byPairId.get(r.pair_id)!.push({
            ts, o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low), c: parseFloat(r.close),
        });
        allTimes.add(ts);
    }
    // Honest gap handling: every traded pair must have candle coverage.
    for (const pid of pairIds) {
        if (byPairId.get(pid)!.length === 0) throw new ReplayError("insufficient_candle_data");
    }
    return { byPairId, times: [...allTimes].sort((a, b) => a - b) };
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
    const fillsByUser = new Map(players.map((u) => [u, raw.filter((r) => r.user_id === u).map(toFill)]));

    const first = raw[0]!.executed_at.getTime();
    const last = raw[raw.length - 1]!.executed_at.getTime();
    const pairIds = [...new Set(raw.map((r) => r.pair_id))];
    const symbolByPairId = new Map(raw.map((r) => [r.pair_id, r.symbol]));
    const { byPairId, times } = await loadCandles(
        pairIds, new Date(first - WINDOW_PAD_MS), new Date(last + WINDOW_PAD_MS),
    );
    const markPrice = buildMarkPrice(byPairId);
    const startingCapital = parseFloat(match.starting_capital);

    const curves: Record<string, CurvePoint[]> = {};
    const positions: ReplayPosition[] = [];
    for (const userId of players) {
        const fills = fillsByUser.get(userId)!;
        curves[userId] = reconstructFillCurve(fills, times, markPrice, startingCapital, CANDLE_MS);
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

    const candles: Record<string, ReplayCandle[]> = {};
    for (const pid of pairIds) candles[symbolByPairId.get(pid)!] = byPairId.get(pid)!;

    return { match: matchHeader(match, startingCapital), candles, positions, curves, source: "fills" };
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

    // Window = [min(opened_at), max(closed_at)] padded ±1h.
    let minOpen = Infinity;
    let maxClose = -Infinity;
    for (const p of rawPositions) {
        const o = p.opened_at.getTime();
        const c = (p.closed_at ?? p.opened_at).getTime();
        if (o < minOpen) minOpen = o;
        if (c > maxClose) maxClose = c;
    }
    const windowStart = new Date(minOpen - WINDOW_PAD_MS);
    const windowEnd = new Date(maxClose + WINDOW_PAD_MS);

    const pairIds = [...new Set(rawPositions.map((p) => p.pair_id))];
    const symbolByPairId = new Map(rawPositions.map((p) => [p.pair_id, p.symbol]));

    const { byPairId: candlesByPairId, times: candleTimes } = await loadCandles(pairIds, windowStart, windowEnd);
    const markPrice = buildMarkPrice(candlesByPairId);
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
        curves[userId] = reconstructPnlCurve(positions, candleTimes, markPrice, startingCapital);
    }

    // Candles keyed by symbol for the response.
    const candles: Record<string, ReplayCandle[]> = {};
    for (const pid of pairIds) {
        candles[symbolByPairId.get(pid)!] = candlesByPairId.get(pid)!;
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
        candles,
        positions,
        curves,
        source: "match_positions",
    };
}
