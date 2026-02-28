import { pool } from "../db/pool";
import type { SimulationConfig } from "./simTypes";

const DEFAULTS: SimulationConfig = {
    base_spread_bps: 5,
    base_slippage_bps: 2,
    impact_bps_per_10k_quote: 10,
    liquidity_quote_per_tick: 50000,
    volatility_widening_k: 0.5,
};

export async function resolveSimulationConfig(
    userId: string,
    pairId: string
): Promise<SimulationConfig> {
    const { rows } = await pool.query<{ config_json: SimulationConfig }>(
        `SELECT config_json
         FROM simulation_settings
         WHERE (user_id = $1 OR user_id IS NULL)
           AND (pair_id = $2 OR pair_id IS NULL)
         ORDER BY
           (user_id IS NOT NULL)::int DESC,
           (pair_id IS NOT NULL)::int DESC
         LIMIT 1`,
        [userId, pairId]
    );
    return rows[0]?.config_json ?? DEFAULTS;
}

export async function upsertSimulationConfig(
    userId: string | null,
    pairId: string | null,
    config: SimulationConfig
): Promise<void> {
    await pool.query(
        `INSERT INTO simulation_settings (user_id, pair_id, config_json, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT ON CONSTRAINT uq_sim_settings_user_pair
         DO UPDATE SET config_json = $3, updated_at = now()`,
        [userId, pairId, JSON.stringify(config)]
    );
}

export async function getSimulationConfigForUser(
    userId: string,
    pairId?: string
): Promise<SimulationConfig> {
    if (pairId) return resolveSimulationConfig(userId, pairId);
    const { rows } = await pool.query<{ config_json: SimulationConfig }>(
        `SELECT config_json
         FROM simulation_settings
         WHERE (user_id = $1 OR user_id IS NULL)
           AND pair_id IS NULL
         ORDER BY (user_id IS NOT NULL)::int DESC
         LIMIT 1`,
        [userId]
    );
    return rows[0]?.config_json ?? DEFAULTS;
}
