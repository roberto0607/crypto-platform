import type { JobDefinition } from "../jobTypes";
import { registerProtectionOrFlatten, type ApprovedProposal } from "../../agents/executionAgent/executor";
import { ensureRiskAgentBotSetup } from "../../agents/riskAgent/botSetup";
import { config } from "../../config";

interface RecoveryCandidateRow {
    id: string;
    pair_id: string;
    side: "BUY" | "SELL";
    entry_price: string;
    stop_price: string;
    target_price: string;
    qty: string | null;
    stop_distance_pct: string | null;
    executed_order_id: string | null;
}

/**
 * Execution Agent crash-recovery — runs every 60s (tighter than
 * matchCleanupJob's 300s: a flagged row here means a REAL, currently
 * open position sitting with zero stop/target protection, accruing
 * risk exposure every second it goes undetected — unlike a stale
 * PENDING match, where lateness costs nothing).
 *
 * Finds `executed` trade_proposals rows that never got a complete,
 * healthy protection pair and never got auto-flattened either, then
 * retries registerProtectionOrFlatten against them. Three ways a row
 * ends up here, all needing the same remedy:
 *   - Crashed between Phase 1 (order placed, outcome='executed'
 *     committed) and Phase 2 (protection registration) — zero
 *     trigger_orders rows exist for it.
 *   - Crashed mid-Phase-2, between the two createTriggerOrder calls —
 *     exactly one leg (one kind) registered, the other never attempted.
 *   - Phase 2 exhausted its own retries AND the auto-flatten fallback
 *     also failed — flatten_order_id stayed NULL.
 *
 * Deliberately excluded (must NOT be flagged):
 *   - Healthy protection: both STOP_MARKET and TAKE_PROFIT_MARKET
 *     present as ACTIVE — two distinct kinds present.
 *   - A normal OCO fire: one leg TRIGGERED, the sibling CANCELED via
 *     triggerRepo.cancelOcoSiblingTx — both kinds still present, just
 *     no longer ACTIVE. This is why the query counts DISTINCT kind
 *     among ACTIVE/TRIGGERED/CANCELED rows rather than just checking
 *     "no ACTIVE row exists" — that weaker check would both (a) wrongly
 *     exclude a real single-leg crash (one ACTIVE row, but only one
 *     kind) and (b) wrongly include nothing extra for a normal fire
 *     that happens to leave one CANCELED leg. Counting kinds is what
 *     tells "one healthy leg" apart from "both legs healthy, one
 *     already fired."
 *   - Auto-flatten already succeeded: flatten_order_id is set.
 *
 * See executor.ts's registerProtectionOrFlatten for what happens when a
 * retried row fails AGAIN here (the `origin: "recovery"` branch) — a
 * second consecutive failure gets its own log event
 * (execution_agent_recovery_also_failed) and its own agent_decisions
 * value (recovery_also_failed), not the same signal as a first-time
 * failure.
 */
export const executionAgentRecoveryJob: JobDefinition = {
    name: "execution-agent-recovery",
    intervalSeconds: 60,
    timeoutMs: 45_000,
    async run(ctx) {
        await ensureRiskAgentBotSetup();
        const botUserId = config.riskAgentBotUserId;

        const { rows: candidates } = await ctx.pool.query<RecoveryCandidateRow>(
            `SELECT tp.id, tp.pair_id, tp.side, tp.entry_price, tp.stop_price, tp.target_price,
                    tp.qty, tp.stop_distance_pct, tp.executed_order_id
             FROM trade_proposals tp
             WHERE tp.outcome = 'executed'
               AND tp.flatten_order_id IS NULL
               AND (
                 SELECT COUNT(DISTINCT t.kind)
                 FROM trigger_orders t
                 WHERE t.trade_proposal_id = tp.id
                   AND t.kind IN ('STOP_MARKET', 'TAKE_PROFIT_MARKET')
                   AND t.status IN ('ACTIVE', 'TRIGGERED', 'CANCELED')
               ) < 2
             LIMIT 50`,
        );

        let recovered = 0;
        let stillFailed = 0;
        let skipped = 0;

        for (const row of candidates) {
            try {
                // Defense in depth, same philosophy as executor.ts's own
                // Phase 1 guard: qty/stop_distance_pct/executed_order_id are
                // nullable at the DB level but structurally guaranteed
                // non-null once outcome='executed' (Phase 1 sets all three
                // together, atomically, before Phase 2 ever runs). Never
                // proceed on a null.
                if (!row.qty || !row.stop_distance_pct || !row.executed_order_id) {
                    skipped++;
                    ctx.logger.warn({ proposalId: row.id }, "execution_agent_recovery_row_missing_fields");
                    continue;
                }

                const proposal: ApprovedProposal = {
                    id: row.id,
                    pair_id: row.pair_id,
                    side: row.side,
                    entry_price: row.entry_price,
                    stop_price: row.stop_price,
                    target_price: row.target_price,
                    qty: row.qty,
                    stop_distance_pct: row.stop_distance_pct,
                };

                const result = await registerProtectionOrFlatten(proposal, row.executed_order_id, botUserId, "recovery");
                if (result.reason === "recovery_also_failed") {
                    stillFailed++;
                } else {
                    recovered++;
                }
            } catch (err) {
                // Real error (e.g. DB connection failure) — one bad row
                // must not break the whole tick (error isolation, same
                // philosophy as matchCleanupJob's per-match try/catch).
                stillFailed++;
                ctx.logger.error({ proposalId: row.id, err }, "execution_agent_recovery_row_failed");
            }
        }

        if (recovered + stillFailed + skipped > 0) {
            ctx.logger.info(
                { candidates: candidates.length, recovered, stillFailed, skipped },
                "execution_agent_recovery_done",
            );
        }
    },
};
