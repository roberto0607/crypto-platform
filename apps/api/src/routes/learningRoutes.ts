/**
 * learningRoutes.ts — GET /api/market/learning
 *
 * Returns adaptive learning status: recent signals, stream performance,
 * regime performance, and current learned weights.
 */

import type { FastifyInstance } from "fastify";
import { getRecentSignals, getSignalCount } from "../market/signalLogger";
import { getLearnedWeights, getBaseWeights } from "../market/weightAdjuster";
import { pool } from "../db/pool";

export default async function learningRoutes(app: FastifyInstance) {
    app.get("/api/market/learning", async (_req, reply) => {
        reply.header("Cache-Control", "no-cache");

        const [
            signalCount,
            recentSignals,
            streamPerf,
            regimePerf,
        ] = await Promise.all([
            getSignalCount(),
            getRecentSignals(50),
            pool.query(`SELECT * FROM stream_performance ORDER BY stream_name, regime`),
            pool.query(`SELECT * FROM regime_performance ORDER BY regime`),
        ]);

        // Get learned weights for all known regimes
        const regimes = [...new Set(regimePerf.rows.map((r: { regime: string }) => r.regime))];
        const weightsByRegime: Record<string, Awaited<ReturnType<typeof getLearnedWeights>>> = {};
        for (const regime of regimes) {
            weightsByRegime[regime] = await getLearnedWeights(regime);
        }

        return {
            signalCount,
            recentSignals,
            streamPerformance: streamPerf.rows,
            regimePerformance: regimePerf.rows,
            baseWeights: getBaseWeights(),
            learnedWeightsByRegime: weightsByRegime,
        };
    });
}
