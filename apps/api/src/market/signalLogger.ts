/**
 * signalLogger.ts — Logs intelligence signals to DB for outcome tracking.
 *
 * Only logs when score changes by >0.05 from last logged signal
 * to avoid storing identical readings every 30s.
 */

import { pool } from "../db/pool";

export interface SignalLogRow {
    id: number;
    timestamp: string;
    btc_price: number;
    action: string;
    score: number;
    score_label: string;
    regime: string;
    regime_confidence: number;
    basis_score: number | null;
    orderbook_score: number | null;
    macro_score: number | null;
    gamma_score: number | null;
    onchain_score: number | null;
    convergence: string | null;
    streams_agreeing: number | null;
    weights_used: Record<string, number> | null;
    outcome_30m: string | null;
    outcome_1h: string | null;
    outcome_4h: string | null;
    price_30m: number | null;
    price_1h: number | null;
    price_4h: number | null;
    graded_at: string | null;
}

let lastLoggedScore: number | null = null;

export function shouldLog(score: number): boolean {
    if (lastLoggedScore === null) return true;
    return Math.abs(score - lastLoggedScore) > 0.05;
}

export async function logSignal(intel: {
    headline: { action: string; score: number; scoreLabel: string; regime: string; regimeConfidence: number };
    streams: {
        basis: { score: number };
        orderBook: { score: number };
        macro: { score: number };
        gamma: { score: number };
        onChain: { score: number };
    };
    convergence: { level: string; streamsAgreeing: number };
    weights: Record<string, number>;
    rawSnapshot: { btcPrice: number };
}): Promise<number> {
    try {
        const res = await pool.query(
            `INSERT INTO signal_log (
                btc_price, action, score, score_label, regime, regime_confidence,
                basis_score, orderbook_score, macro_score, gamma_score, onchain_score,
                convergence, streams_agreeing, weights_used
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING id`,
            [
                intel.rawSnapshot.btcPrice,
                intel.headline.action,
                intel.headline.score,
                intel.headline.scoreLabel,
                intel.headline.regime,
                intel.headline.regimeConfidence,
                intel.streams.basis.score,
                intel.streams.orderBook.score,
                intel.streams.macro.score,
                intel.streams.gamma.score,
                intel.streams.onChain.score,
                intel.convergence.level,
                intel.convergence.streamsAgreeing,
                JSON.stringify(intel.weights),
            ],
        );

        const id = res.rows[0].id;
        lastLoggedScore = intel.headline.score;

        console.log(
            `[SignalLogger] Signal logged: id=${id} action=${intel.headline.action} ` +
            `score=${intel.headline.score} regime=${intel.headline.regime}`,
        );

        return id;
    } catch (err) {
        console.warn("[SignalLogger] DB error:", (err as Error).message);
        return -1;
    }
}

export async function getRecentSignals(limit = 100): Promise<SignalLogRow[]> {
    try {
        const res = await pool.query(
            `SELECT * FROM signal_log ORDER BY timestamp DESC LIMIT $1`,
            [limit],
        );
        return res.rows;
    } catch (err) {
        console.warn("[SignalLogger] getRecentSignals error:", (err as Error).message);
        return [];
    }
}

export async function getSignalCount(): Promise<{ total: number; graded: number }> {
    try {
        const res = await pool.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(graded_at)::int AS graded
            FROM signal_log`,
        );
        return res.rows[0] ?? { total: 0, graded: 0 };
    } catch {
        return { total: 0, graded: 0 };
    }
}
