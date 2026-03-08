import { createNotification } from "./notificationRepo.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { logger } from "../observability/logContext.js";

/**
 * Send a notification to a user. Persists to DB and pushes via SSE.
 */
export async function notify(params: {
    userId: string;
    kind: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    try {
        const notification = await createNotification(params);

        // Push via SSE so the frontend can update the badge in real-time
        publish(createEvent("notification.created", {
            notificationId: notification.id,
            kind: notification.kind,
            title: notification.title,
            body: notification.body,
        }, { userId: params.userId }));
    } catch (err) {
        logger.error({ err, ...params }, "notification_creation_failed");
    }
}

// ── Convenience helpers for specific event types ──

export async function notifyCompetitionStarted(
    userId: string,
    competitionName: string,
    competitionId: string,
): Promise<void> {
    await notify({
        userId,
        kind: "COMPETITION_STARTED",
        title: `${competitionName} has started!`,
        body: "The competition is now active. Start trading to climb the leaderboard.",
        metadata: { competitionId },
    });
}

export async function notifyCompetitionEnded(
    userId: string,
    competitionName: string,
    competitionId: string,
    finalRank: number | null,
): Promise<void> {
    const rankText = finalRank ? ` You finished #${finalRank}.` : "";
    await notify({
        userId,
        kind: "COMPETITION_ENDED",
        title: `${competitionName} has ended!`,
        body: `The competition is over.${rankText} Check the final leaderboard.`,
        metadata: { competitionId, finalRank },
    });
}

export async function notifyRankChanged(
    userId: string,
    competitionName: string,
    competitionId: string,
    oldRank: number,
    newRank: number,
): Promise<void> {
    const direction = newRank < oldRank ? "up" : "down";
    const arrow = newRank < oldRank ? "^" : "v";
    await notify({
        userId,
        kind: "RANK_CHANGED",
        title: `Rank ${arrow} #${newRank} in ${competitionName}`,
        body: `You moved ${direction} from #${oldRank} to #${newRank}.`,
        metadata: { competitionId, oldRank, newRank },
    });
}

export async function notifyTriggerFired(
    userId: string,
    pairSymbol: string,
    triggerKind: string,
    side: string,
): Promise<void> {
    await notify({
        userId,
        kind: "TRIGGER_FIRED",
        title: `${triggerKind} trigger fired on ${pairSymbol}`,
        body: `Your ${side} ${triggerKind.toLowerCase()} order has been triggered.`,
        metadata: { pairSymbol, triggerKind, side },
    });
}

export async function notifyOrderFilled(
    userId: string,
    pairSymbol: string,
    side: string,
    qty: string,
    price: string,
): Promise<void> {
    await notify({
        userId,
        kind: "ORDER_FILLED",
        title: `${side} order filled on ${pairSymbol}`,
        body: `${qty} @ $${parseFloat(price).toLocaleString()}`,
        metadata: { pairSymbol, side, qty, price },
    });
}

export async function notifyTierPromotion(
    userId: string,
    oldTier: string,
    newTier: string,
    weekId: string,
): Promise<void> {
    await notify({
        userId,
        kind: "TIER_PROMOTION",
        title: `Promoted to ${newTier}!`,
        body: `Great performance! You moved up from ${oldTier} to ${newTier}.`,
        metadata: { oldTier, newTier, weekId },
    });
}

export async function notifyTierDemotion(
    userId: string,
    oldTier: string,
    newTier: string,
    weekId: string,
): Promise<void> {
    await notify({
        userId,
        kind: "TIER_DEMOTION",
        title: `Moved to ${newTier}`,
        body: `You moved from ${oldTier} to ${newTier}. Keep trading to climb back up!`,
        metadata: { oldTier, newTier, weekId },
    });
}

export async function notifyWeeklyChampion(
    userId: string,
    tier: string,
    weekId: string,
    competitionId: string,
): Promise<void> {
    await notify({
        userId,
        kind: "WEEKLY_CHAMPION",
        title: `Weekly Champion - ${tier}!`,
        body: `You finished #1 in the ${tier} tier. A champion badge has been added to your profile!`,
        metadata: { tier, weekId, competitionId },
    });
}
