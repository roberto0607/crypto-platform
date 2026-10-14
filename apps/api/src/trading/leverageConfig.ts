/**
 * Leverage flags and caps (docs/designs/2026-10-13-leverage-design.md §6).
 *
 *   LEVERAGE_ENABLED         false   the isolated-margin path for real users.
 *                                    Off: every order trades exactly as today
 *                                    (spot, 1x) and leverageCap() is 1.
 *   LIQUIDATION_MODE         log_only  off | log_only | execute
 *   LEVERAGE_MAX_FREE_PLAY   10      per-mode caps; a pair's own
 *   LEVERAGE_MAX_MATCH       5       trading_pairs.max_leverage applies on top.
 *   LEVERAGE_MAX_COMPETITION 1      The match cap is stamped on the match at
 *                                    accept, so changing it never affects a
 *                                    match in progress.
 *   LEVERAGE_ALLOWLIST       ""      comma-separated user ids. Non-empty: only
 *                                    these users get above 1x (rollout phase 1).
 *
 * A malformed value throws at boot rather than trading on a guess.
 */

export const LIQUIDATION_MODES = ["off", "log_only", "execute"] as const;
export type LiquidationMode = (typeof LIQUIDATION_MODES)[number];

export type LeverageMode = "FREE_PLAY" | "MATCH" | "COMPETITION";

export type LeverageConfig = {
    enabled: boolean;
    liquidationMode: LiquidationMode;
    maxFreePlay: number;
    maxMatch: number;
    maxCompetition: number;
    /** Empty = no allowlist (everyone gets the caps). */
    allowlist: string[];
};

/** Highest leverage any cap may be set to. */
export const LEVERAGE_CEILING = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function capEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > LEVERAGE_CEILING || Math.round(n * 100) !== n * 100) {
        throw new Error(`Env var ${name} must be a leverage between 1 and ${LEVERAGE_CEILING} (at most 2 decimals), got "${raw}"`);
    }
    return n;
}

export function parseLeverageConfig(env: NodeJS.ProcessEnv): LeverageConfig {
    const mode = env.LIQUIDATION_MODE || "log_only";
    if (!(LIQUIDATION_MODES as readonly string[]).includes(mode)) {
        throw new Error(`Env var LIQUIDATION_MODE must be one of ${LIQUIDATION_MODES.join(", ")}, got "${mode}"`);
    }

    const allowlist = (env.LEVERAGE_ALLOWLIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const bad = allowlist.find((id) => !UUID.test(id));
    if (bad !== undefined) throw new Error(`Env var LEVERAGE_ALLOWLIST: not a user id: "${bad}"`);

    return {
        enabled: env.LEVERAGE_ENABLED === "true" || env.LEVERAGE_ENABLED === "1",
        liquidationMode: mode as LiquidationMode,
        maxFreePlay: capEnv(env, "LEVERAGE_MAX_FREE_PLAY", 10),
        maxMatch: capEnv(env, "LEVERAGE_MAX_MATCH", 5),
        maxCompetition: capEnv(env, "LEVERAGE_MAX_COMPETITION", 1),
        allowlist: allowlist.map((id) => id.toLowerCase()),
    };
}

/**
 * The highest leverage `userId` may open in `mode` on a pair:
 *   - 1 while leverage is disabled;
 *   - the mode's cap (a match uses its own stamped max_leverage; a match
 *     stamped before leverage, or a SPOT match, is 1x);
 *   - 1 for anyone not on a non-empty allowlist;
 *   - never above the pair's own max_leverage.
 */
export function leverageCap(
    cfg: LeverageConfig,
    ctx: { mode: LeverageMode; userId: string; pairMaxLeverage: number; matchMaxLeverage?: number | null },
): number {
    if (!cfg.enabled) return 1;
    if (cfg.allowlist.length > 0 && !cfg.allowlist.includes(ctx.userId.toLowerCase())) return 1;

    const modeCap = ctx.mode === "FREE_PLAY" ? cfg.maxFreePlay
        : ctx.mode === "MATCH" ? (ctx.matchMaxLeverage ?? 1)
        : cfg.maxCompetition;
    return Math.max(1, Math.min(modeCap, ctx.pairMaxLeverage));
}
