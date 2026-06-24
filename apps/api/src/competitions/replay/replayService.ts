/**
 * replayService.ts — DB read layer for match replay.
 *
 * Loads a completed match's positions + 5m candle window and runs
 * reconstructPnlCurve per player into a per-candle equity/P&L curve.
 *
 * SOURCE TABLE: match_positions. It is the only table carrying the temporal
 * shape replay needs (side, entry, exit, qty, opened_at, closed_at, stored
 * realized pnl). The live `positions` table is a point-in-time aggregate
 * (base_qty, avg_entry_price, realized_pnl_quote — no open/close timestamps or
 * side), so it cannot drive a candle-by-candle reconstruction. Today only the
 * demo seed populates match_positions; real matches have none, so they return
 * a clear "no_replay_data" rather than a fabricated curve.
 */
import { pool } from "../../db/pool.js";
import { getMatchById } from "../matchService.js";
import {
    reconstructPnlCurve,
    type NormalizedPosition,
    type CurvePoint,
    type MarkPriceLookup,
} from "./reconstructPnlCurve.js";

const HOUR_MS = 3_600_000;
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
    source: "match_positions";
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

    if (rawPositions.length === 0) throw new ReplayError("no_replay_data");

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

    // Load 5m candles per traded pair across the window.
    const { rows: rawCandles } = await pool.query<{
        pair_id: string; ts: Date; open: string; high: string; low: string; close: string;
    }>(
        `SELECT pair_id, ts, open, high, low, close
         FROM candles
         WHERE pair_id = ANY($1) AND timeframe = '5m' AND ts >= $2 AND ts <= $3
         ORDER BY ts ASC`,
        [pairIds, windowStart, windowEnd],
    );

    const candlesByPairId = new Map<string, ReplayCandle[]>();
    for (const pid of pairIds) candlesByPairId.set(pid, []);
    const allTimes = new Set<number>();
    for (const r of rawCandles) {
        const ts = r.ts.getTime();
        candlesByPairId.get(r.pair_id)!.push({
            ts, o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low), c: parseFloat(r.close),
        });
        allTimes.add(ts);
    }

    // Honest gap handling: every traded pair must have candle coverage.
    for (const pid of pairIds) {
        if (candlesByPairId.get(pid)!.length === 0) {
            throw new ReplayError("insufficient_candle_data");
        }
    }

    const candleTimes = [...allTimes].sort((a, b) => a - b);
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
        match: {
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
        },
        candles,
        positions,
        curves,
        source: "match_positions",
    };
}
