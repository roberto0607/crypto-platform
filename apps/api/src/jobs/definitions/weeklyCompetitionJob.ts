import type { JobDefinition } from "../jobTypes";
import { TIERS, WEEKLY_MIN_TRADES, type TierName } from "../../competitions/competitionTypes";
import {
    createCompetition,
    findWeeklyCompetition,
    listEndedUnprocessedWeekly,
    markTierAdjustmentsProcessed,
} from "../../competitions/competitionRepo";
import { listActiveParticipants } from "../../competitions/participantRepo";
import { getLeaderboard } from "../../competitions/leaderboardRepo";
import { getUserTier, updateUserTier } from "../../competitions/tierRepo";
import { awardBadge } from "../../competitions/badgeRepo";
import {
    getISOWeekId,
    getWeekStart,
    getWeekEnd,
    getNextWeekStart,
    weeklyCompetitionName,
    tierUp,
    tierDown,
} from "../../competitions/weeklyUtils";
import {
    notifyTierPromotion,
    notifyTierDemotion,
    notifyWeeklyChampion,
} from "../../notifications/notificationService";
import { pool } from "../../db/pool";

/**
 * Weekly Competition Job — runs every 6 hours (idempotent).
 *
 * Phase A: Create this week's + next week's competitions (6 tiers each).
 * Phase B: Process tier adjustments for ended weekly competitions.
 */
export const weeklyCompetitionJob: JobDefinition = {
    name: "weekly-competition",
    intervalSeconds: 21_600, // 6 hours
    timeoutMs: 60_000,
    async run(ctx) {
        // ── Phase A: Create competitions ──
        await createWeeklyCompetitions(ctx);

        // ── Phase B: Process tier adjustments ──
        await processTierAdjustments(ctx);
    },
};

async function createWeeklyCompetitions(ctx: { logger: any }): Promise<void> {
    const now = new Date();

    // Create for current week and next week
    const weeks = [
        { start: getWeekStart(now), weekId: getISOWeekId(now) },
        { start: getNextWeekStart(now), weekId: getISOWeekId(getNextWeekStart(now)) },
    ];

    for (const { start, weekId } of weeks) {
        const end = getWeekEnd(start);

        for (const tier of TIERS) {
            const existing = await findWeeklyCompetition(tier, weekId);
            if (existing) continue;

            try {
                await createCompetition({
                    name: weeklyCompetitionName(tier, start),
                    description: `Weekly trading competition for ${tier.charAt(0) + tier.slice(1).toLowerCase()} tier. Trade BTC, ETH, and SOL with $100,000. Top 20% rank up. Minimum ${WEEKLY_MIN_TRADES} trades to qualify.`,
                    startAt: start.toISOString(),
                    endAt: end.toISOString(),
                    startingBalanceUsd: "100000.00000000",
                    pairsAllowed: "all",
                    createdBy: null,
                    competitionType: "WEEKLY",
                    tier,
                    weekId,
                });

                ctx.logger.info({ tier, weekId }, "weekly_competition_created");
            } catch (err: any) {
                // Unique index violation = already created (race condition)
                if (err.code === "23505") continue;
                ctx.logger.error({ err, tier, weekId }, "weekly_competition_create_failed");
            }
        }
    }
}

async function processTierAdjustments(ctx: { logger: any }): Promise<void> {
    const unprocessed = await listEndedUnprocessedWeekly();

    for (const comp of unprocessed) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const tier = comp.tier as TierName;
            const weekId = comp.week_id!;

            // Get participants and their leaderboard data (has trades_count)
            const participants = await listActiveParticipants(comp.id);
            const leaderboard = await getLeaderboard(comp.id);
            const tradesByUser = new Map<string, number>();
            for (const entry of leaderboard) {
                tradesByUser.set(entry.user_id, entry.trades_count);
            }

            // Mark qualification on each participant
            for (const p of participants) {
                const trades = tradesByUser.get(p.user_id) ?? 0;
                const qualified = trades >= WEEKLY_MIN_TRADES;
                await client.query(
                    `UPDATE competition_participants SET qualified = $1
                     WHERE competition_id = $2 AND user_id = $3`,
                    [qualified, comp.id, p.user_id],
                );
            }

            // Filter to qualified participants sorted by final_rank
            const qualified = participants
                .filter((p) => (tradesByUser.get(p.user_id) ?? 0) >= WEEKLY_MIN_TRADES)
                .filter((p) => p.final_rank != null)
                .sort((a, b) => a.final_rank! - b.final_rank!);

            const total = qualified.length;

            if (total === 0) {
                await markTierAdjustmentsProcessed(client, comp.id);
                await client.query("COMMIT");
                ctx.logger.info({ competitionId: comp.id, tier, weekId }, "weekly_no_qualified_participants");
                continue;
            }

            // Calculate promotion/demotion counts
            const promoteCount = Math.max(1, Math.floor(total * 0.2));
            const demoteCount = total >= 2 ? Math.max(1, Math.floor(total * 0.2)) : 0;

            const promotions = qualified.slice(0, promoteCount);
            const demotions = qualified.slice(-demoteCount);
            const champion = qualified[0];

            // Track promoted user IDs to avoid double-processing
            const promotedIds = new Set(promotions.map((p) => p.user_id));

            // Process promotions
            for (const p of promotions) {
                const currentTier = await getUserTier(p.user_id);
                const newTier = tierUp(currentTier);
                if (newTier) {
                    await updateUserTier(client, p.user_id, newTier, currentTier, "WEEKLY_PROMOTION", comp.id, weekId);
                    notifyTierPromotion(p.user_id, currentTier, newTier, weekId).catch(() => {});
                }
            }

            // Process demotions (skip anyone who was also promoted)
            for (const p of demotions) {
                if (promotedIds.has(p.user_id)) continue;
                const currentTier = await getUserTier(p.user_id);
                const newTier = tierDown(currentTier);
                if (newTier) {
                    await updateUserTier(client, p.user_id, newTier, currentTier, "WEEKLY_DEMOTION", comp.id, weekId);
                    notifyTierDemotion(p.user_id, currentTier, newTier, weekId).catch(() => {});
                }
            }

            // Award champion badge
            await awardBadge({
                userId: champion.user_id,
                badgeType: "WEEKLY_CHAMPION",
                tier,
                weekId,
                competitionId: comp.id,
            });
            notifyWeeklyChampion(champion.user_id, tier, weekId, comp.id).catch(() => {});

            await markTierAdjustmentsProcessed(client, comp.id);
            await client.query("COMMIT");

            ctx.logger.info({
                competitionId: comp.id,
                tier,
                weekId,
                qualified: total,
                promoted: promotions.length,
                demoted: demotions.filter((p) => !promotedIds.has(p.user_id)).length,
                champion: champion.user_id,
            }, "weekly_tier_adjustments_processed");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            ctx.logger.error({ err, competitionId: comp.id }, "weekly_tier_adjustments_failed");
        } finally {
            client.release();
        }
    }
}
