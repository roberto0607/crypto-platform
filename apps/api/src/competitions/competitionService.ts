import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import { creditWalletTx } from "../wallets/walletRepo.js";
import { getPortfolioSummary, getPerformance } from "../portfolio/portfolioService.js";
import { D, toFixed8 } from "../utils/decimal.js";
import { logger } from "../observability/logContext.js";
import {
    lockCompetitionForUpdate,
    updateCompetitionStatus,
} from "./competitionRepo.js";
import {
    insertParticipant,
    countParticipants,
    findParticipant,
    updateParticipantStatus,
    listActiveParticipants,
    writeFinalsForParticipant,
} from "./participantRepo.js";
import { upsertLeaderboardEntry } from "./leaderboardRepo.js";

export async function joinCompetition(
    userId: string,
    competitionId: string,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Lock competition row
        const comp = await lockCompetitionForUpdate(client, competitionId);
        if (!comp) throw new AppError("competition_not_found");
        if (comp.status !== "UPCOMING" && comp.status !== "ACTIVE") {
            throw new AppError("competition_not_joinable", { status: comp.status });
        }

        // 2. Check max participants
        if (comp.max_participants) {
            const count = await countParticipants(client, competitionId);
            if (count >= comp.max_participants) {
                throw new AppError("competition_full");
            }
        }

        // 3. Check not already joined
        const existing = await findParticipant(competitionId, userId);
        if (existing) {
            throw new AppError("already_joined");
        }

        // 4. Create competition-scoped wallets
        await client.query(
            `INSERT INTO wallets (id, user_id, asset_id, competition_id, balance, reserved)
             SELECT gen_random_uuid(), $1, a.id, $2, '0.00000000', '0.00000000'
             FROM assets a
             ON CONFLICT DO NOTHING`,
            [userId, competitionId],
        );

        // 5. Credit USD wallet with starting balance
        const usdWalletResult = await client.query<{ id: string }>(
            `SELECT w.id FROM wallets w
             JOIN assets a ON a.id = w.asset_id
             WHERE w.user_id = $1 AND w.competition_id = $2 AND a.symbol = 'USD'`,
            [userId, competitionId],
        );

        if (usdWalletResult.rows.length === 0) {
            throw new AppError("wallet_creation_failed");
        }

        await creditWalletTx(
            client,
            usdWalletResult.rows[0].id,
            comp.starting_balance_usd,
            "COMPETITION_CREDIT",
            competitionId,
            "COMPETITION",
            { competitionId, competitionName: comp.name },
        );

        // 6. Insert participant record
        await insertParticipant(client, competitionId, userId, comp.starting_balance_usd);

        await client.query("COMMIT");

        logger.info({ userId, competitionId }, "user_joined_competition");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function withdrawFromCompetition(
    userId: string,
    competitionId: string,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const participant = await findParticipant(competitionId, userId);
        if (!participant || participant.status !== "ACTIVE") {
            throw new AppError("not_participating");
        }

        // Mark as withdrawn
        await updateParticipantStatus(client, competitionId, userId, "WITHDRAWN");

        // Cancel all open orders for this competition
        await client.query(
            `UPDATE orders SET status = 'CANCELED'
             WHERE user_id = $1 AND competition_id = $2
               AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
            [userId, competitionId],
        );

        // Release reserved funds on canceled orders
        await client.query(
            `UPDATE wallets w
             SET reserved = reserved - sub.total_reserved
             FROM (
                 SELECT reserved_wallet_id, SUM(reserved_amount - reserved_consumed) AS total_reserved
                 FROM orders
                 WHERE user_id = $1 AND competition_id = $2 AND status = 'CANCELED'
                   AND reserved_wallet_id IS NOT NULL
                 GROUP BY reserved_wallet_id
             ) sub
             WHERE w.id = sub.reserved_wallet_id`,
            [userId, competitionId],
        );

        await client.query("COMMIT");

        logger.info({ userId, competitionId }, "user_withdrew_from_competition");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function finalizeCompetition(
    competitionId: string,
): Promise<void> {
    const participants = await listActiveParticipants(competitionId);

    // Compute equity and performance for each participant
    const rankings: Array<{
        userId: string;
        equity: string;
        returnPct: string;
        maxDrawdownPct: string;
    }> = [];

    for (const p of participants) {
        const summary = await getPortfolioSummary(p.user_id, undefined, competitionId);
        const equity = summary.equity_quote;
        const startingEquity = D(p.starting_equity);
        const returnPct = startingEquity.gt(0)
            ? D(equity).minus(startingEquity).div(startingEquity).mul(100)
            : D(0);

        // Get max drawdown from equity snapshots scoped to this competition
        const perf = await getPerformance(p.user_id, undefined, undefined, competitionId);

        rankings.push({
            userId: p.user_id,
            equity,
            returnPct: toFixed8(returnPct),
            maxDrawdownPct: perf.max_drawdown_pct,
        });
    }

    // Sort by return_pct DESC, tiebreaker: lower max_drawdown
    rankings.sort((a, b) => {
        const retDiff = D(b.returnPct).minus(D(a.returnPct)).toNumber();
        if (retDiff !== 0) return retDiff;
        return D(a.maxDrawdownPct).minus(D(b.maxDrawdownPct)).toNumber();
    });

    // Write finals in a single transaction
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        await updateCompetitionStatus(client, competitionId, "ENDED");

        for (let i = 0; i < rankings.length; i++) {
            const r = rankings[i];
            await writeFinalsForParticipant(
                client,
                competitionId,
                r.userId,
                r.equity,
                r.returnPct,
                r.maxDrawdownPct,
                i + 1,
            );
        }

        await client.query("COMMIT");

        logger.info(
            { competitionId, participantCount: rankings.length },
            "competition_finalized",
        );
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function refreshLeaderboard(
    competitionId: string,
): Promise<void> {
    const participants = await listActiveParticipants(competitionId);

    const entries: Array<{
        userId: string;
        equity: string;
        returnPct: string;
        maxDrawdownPct: string;
        currentDrawdownPct: string;
        tradesCount: number;
    }> = [];

    for (const p of participants) {
        const summary = await getPortfolioSummary(p.user_id, undefined, competitionId);
        const startingEquity = D(p.starting_equity);
        const returnPct = startingEquity.gt(0)
            ? D(summary.equity_quote).minus(startingEquity).div(startingEquity).mul(100)
            : D(0);

        // Trade count for this competition
        const { rows } = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM trades t
             JOIN orders o ON (o.id = t.buy_order_id OR o.id = t.sell_order_id)
             WHERE o.user_id = $1 AND o.competition_id = $2`,
            [p.user_id, competitionId],
        );

        const perf = await getPerformance(p.user_id, undefined, undefined, competitionId);

        entries.push({
            userId: p.user_id,
            equity: summary.equity_quote,
            returnPct: toFixed8(returnPct),
            maxDrawdownPct: perf.max_drawdown_pct,
            currentDrawdownPct: perf.current_drawdown_pct,
            tradesCount: parseInt(rows[0].count),
        });
    }

    // Sort and assign ranks
    entries.sort((a, b) => D(b.returnPct).minus(D(a.returnPct)).toNumber());

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await upsertLeaderboardEntry(competitionId, e.userId, {
            rank: i + 1,
            equity: e.equity,
            returnPct: e.returnPct,
            maxDrawdownPct: e.maxDrawdownPct,
            currentDrawdownPct: e.currentDrawdownPct,
            tradesCount: e.tradesCount,
        });
    }
}
