import { pool } from "../db/pool";
import type { Candle, Timeframe } from "../strategy/types";

/* ── Timeframe normalization (DB lowercase → engine mixed-case) ── */

const TF_MAP: Record<string, Timeframe> = {
    "15m": "15m",
    "4h": "4H",
    "1d": "1D",
};

const TF_REVERSE: Record<Timeframe, string> = {
    "15m": "15m",
    "4H": "4h",
    "1D": "1d",
};

export function normalizeTimeframe(dbTf: string): Timeframe {
    const tf = TF_MAP[dbTf.toLowerCase()];
    if (!tf) throw new Error(`Unknown timeframe: ${dbTf}`);
    return tf;
}

export function dbTimeframe(tf: Timeframe): string {
    return TF_REVERSE[tf];
}

/* ── Load candles from DB ─────────────────────── */

interface CandleDbRow {
    ts: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    timeframe: string;
}

function rowToCandle(row: CandleDbRow): Candle {
    return {
        timestamp: row.ts,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseFloat(row.volume),
        timeframe: normalizeTimeframe(row.timeframe),
    };
}

/**
 * Load up to `limit` candles for a given pair + timeframe
 * with ts <= upToTs, ordered ascending (oldest first).
 */
export async function loadCandlesUpTo(
    pairId: string,
    timeframe: Timeframe,
    upToTs: number,
    limit: number
): Promise<Candle[]> {
    const tsIso = new Date(upToTs).toISOString();
    const result = await pool.query<CandleDbRow>(
        `
        SELECT ts, open, high, low, close, volume, timeframe
        FROM candles
        WHERE pair_id = $1 AND timeframe = $2 AND ts <= $3
        ORDER BY ts DESC
        LIMIT $4
        `,
        [pairId, dbTimeframe(timeframe), tsIso, limit]
    );
    // Reverse so oldest is first (ascending order for engine)
    return result.rows.reverse().map(rowToCandle);
}

/* ── Warmup loader ────────────────────────────── */

const WARMUP_15M = 200;
const WARMUP_4H = 60;
const WARMUP_1D = 30;

/**
 * Load warmup candles for all three timeframes needed by StrategyEngine.
 */
export async function loadWarmupCandles(
    pairId: string,
    upToTs: number
): Promise<{ candles15m: Candle[]; candles4H: Candle[]; candles1D: Candle[] }> {
    const [candles15m, candles4H, candles1D] = await Promise.all([
        loadCandlesUpTo(pairId, "15m", upToTs, WARMUP_15M),
        loadCandlesUpTo(pairId, "4H", upToTs, WARMUP_4H),
        loadCandlesUpTo(pairId, "1D", upToTs, WARMUP_1D),
    ]);
    return { candles15m, candles4H, candles1D };
}
