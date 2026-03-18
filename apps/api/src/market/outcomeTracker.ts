/**
 * outcomeTracker.ts — Grades logged signals at 30m, 1h, 4h windows.
 *
 * Runs every 5 minutes. For each ungraded signal whose time window
 * has elapsed, fetches BTC price and determines if the signal's
 * predicted direction was correct.
 */

import { pool } from "../db/pool";

const COINBASE_TICKER = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function fetchBtcPrice(): Promise<number> {
    const res = await fetch(COINBASE_TICKER);
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    const json = (await res.json()) as { data: { amount: string } };
    return parseFloat(json.data.amount);
}

function gradeOutcome(
    action: string,
    entryPrice: number,
    exitPrice: number,
): string {
    const pctChange = ((exitPrice - entryPrice) / entryPrice) * 100;

    if (action === "STRONG_BUY" || action === "BUY") {
        if (pctChange > 0.5) return "WIN";
        if (pctChange > 0) return "MARGINAL";
        return "LOSS";
    }
    if (action === "STRONG_SELL" || action === "SELL") {
        if (pctChange < -0.5) return "WIN";
        if (pctChange < 0) return "MARGINAL";
        return "LOSS";
    }
    // HOLD — correct if price stayed within ±0.3%
    if (Math.abs(pctChange) < 0.3) return "WIN";
    return "LOSS";
}

async function gradeWindow(
    windowCol: string,
    priceCol: string,
    intervalMinutes: number,
): Promise<number> {
    // Find signals that are old enough but haven't been graded for this window
    const { rows } = await pool.query(
        `SELECT id, btc_price, action
         FROM signal_log
         WHERE ${windowCol} IS NULL
           AND timestamp < NOW() - INTERVAL '${intervalMinutes} minutes'
         ORDER BY timestamp ASC
         LIMIT 100`,
    );

    if (rows.length === 0) return 0;

    const currentPrice = await fetchBtcPrice();
    let graded = 0;

    for (const row of rows) {
        const outcome = gradeOutcome(
            row.action,
            parseFloat(row.btc_price),
            currentPrice,
        );

        await pool.query(
            `UPDATE signal_log
             SET ${windowCol} = $1, ${priceCol} = $2,
                 graded_at = COALESCE(graded_at, NOW())
             WHERE id = $3`,
            [outcome, currentPrice, row.id],
        );
        graded++;
    }

    return graded;
}

async function updateStreamPerformance(): Promise<void> {
    // Only recompute from signals that have at least 1h grading
    const { rows: signals } = await pool.query(
        `SELECT action, score, regime,
                basis_score, orderbook_score, macro_score,
                gamma_score, onchain_score,
                outcome_1h
         FROM signal_log
         WHERE outcome_1h IS NOT NULL
         ORDER BY timestamp DESC
         LIMIT 500`,
    );

    if (signals.length === 0) return;

    const streamNames = ["basis", "orderbook", "macro", "gamma", "onchain"] as const;
    const scoreKeys = [
        "basis_score", "orderbook_score", "macro_score",
        "gamma_score", "onchain_score",
    ] as const;

    // Group by stream × regime
    const buckets: Record<string, {
        correct: number;
        total: number;
        scoresCorrect: number[];
        scoresWrong: number[];
        last10: string[];
    }> = {};

    for (const sig of signals) {
        for (let i = 0; i < streamNames.length; i++) {
            const stream = streamNames[i]!;
            const scoreVal = parseFloat(sig[scoreKeys[i]!]);
            if (isNaN(scoreVal)) continue;

            const key = `${stream}:${sig.regime}`;
            if (!buckets[key]) {
                buckets[key] = { correct: 0, total: 0, scoresCorrect: [], scoresWrong: [], last10: [] };
            }

            const b = buckets[key]!;
            const isCorrect = sig.outcome_1h === "WIN" || sig.outcome_1h === "MARGINAL";

            b.total++;
            if (isCorrect) {
                b.correct++;
                b.scoresCorrect.push(Math.abs(scoreVal));
            } else {
                b.scoresWrong.push(Math.abs(scoreVal));
            }
            if (b.last10.length < 10) {
                b.last10.push(sig.outcome_1h);
            }
        }
    }

    // Upsert stream_performance rows
    for (const [key, b] of Object.entries(buckets)) {
        const [stream, regime] = key.split(":");
        const accuracy = b.total > 0 ? b.correct / b.total : null;
        const avgCorrect = b.scoresCorrect.length > 0
            ? b.scoresCorrect.reduce((a, c) => a + c, 0) / b.scoresCorrect.length
            : null;
        const avgWrong = b.scoresWrong.length > 0
            ? b.scoresWrong.reduce((a, c) => a + c, 0) / b.scoresWrong.length
            : null;

        // Learned weight: start at 0.20, nudge toward accuracy
        const learnedWeight = accuracy !== null
            ? Math.max(0.05, Math.min(0.50, 0.20 + (accuracy - 0.5) * 0.3))
            : 0.20;

        await pool.query(
            `INSERT INTO stream_performance
                (stream_name, regime, sample_size, accuracy_1h,
                 avg_score_when_correct, avg_score_when_wrong,
                 learned_weight, last_10_outcomes, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (stream_name, regime)
             DO UPDATE SET
                sample_size = $3,
                accuracy_1h = $4,
                avg_score_when_correct = $5,
                avg_score_when_wrong = $6,
                learned_weight = $7,
                last_10_outcomes = $8,
                updated_at = NOW()`,
            [stream, regime, b.total, accuracy, avgCorrect, avgWrong, learnedWeight, b.last10],
        );
    }
}

async function updateRegimePerformance(): Promise<void> {
    await pool.query(
        `INSERT INTO regime_performance (regime, total_signals, correct_direction_1h, accuracy_1h, avg_confidence, updated_at)
         SELECT
             regime,
             COUNT(*)::int,
             COUNT(*) FILTER (WHERE outcome_1h IN ('WIN','MARGINAL'))::int,
             CASE WHEN COUNT(*) > 0
                  THEN COUNT(*) FILTER (WHERE outcome_1h IN ('WIN','MARGINAL'))::numeric / COUNT(*)
                  ELSE NULL END,
             AVG(regime_confidence),
             NOW()
         FROM signal_log
         WHERE outcome_1h IS NOT NULL
         GROUP BY regime
         ON CONFLICT (regime)
         DO UPDATE SET
             total_signals = EXCLUDED.total_signals,
             correct_direction_1h = EXCLUDED.correct_direction_1h,
             accuracy_1h = EXCLUDED.accuracy_1h,
             avg_confidence = EXCLUDED.avg_confidence,
             updated_at = NOW()`,
    );
}

async function tick(): Promise<void> {
    try {
        const g30 = await gradeWindow("outcome_30m", "price_30m", 30);
        const g1h = await gradeWindow("outcome_1h", "price_1h", 60);
        const g4h = await gradeWindow("outcome_4h", "price_4h", 240);

        if (g30 + g1h + g4h > 0) {
            console.log(
                `[OutcomeTracker] Graded: 30m=${g30} 1h=${g1h} 4h=${g4h}`,
            );
            // Update performance tables after grading
            await updateStreamPerformance();
            await updateRegimePerformance();
        }
    } catch (err) {
        console.warn("[OutcomeTracker] tick error:", (err as Error).message);
    }
}

export function initOutcomeTracker(): void {
    console.log("[OutcomeTracker] Starting (5-min interval)");
    // Run first tick after 60s to let signals accumulate
    setTimeout(() => {
        tick();
        intervalHandle = setInterval(tick, 5 * 60 * 1000);
    }, 60_000);
}

export function stopOutcomeTracker(): void {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        console.log("[OutcomeTracker] Stopped");
    }
}
