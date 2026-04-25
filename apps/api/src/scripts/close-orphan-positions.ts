/**
 * close-orphan-positions.ts — One-off cleanup for ghost positions.
 *
 * Problem:
 *   Prior to the forfeitMatch fix, any match that ended via forfeit left its
 *   open match_positions rows with closed_at IS NULL. Those rows can surface
 *   in later queries as "active" positions even though their parent match is
 *   terminal (FORFEITED / COMPLETED-but-skipped / CANCELLED / EXPIRED).
 *
 * What this script does:
 *   - Finds every match_positions row with closed_at IS NULL whose parent
 *     match has a terminal status.
 *   - Computes exit_price using the same fallback chain as
 *     forceCloseOpenPositions:
 *        1. live snapshot (<60s old)  →  getSnapshot(symbol, 60_000)
 *        2. trading_pairs.last_price   →  persisted last price
 *        3. position.entry_price       →  flat close (logged as error)
 *   - Computes pnl from (exit_price - entry_price) × qty (LONG) or inverse.
 *   - Sets closed_at = the parent match's completed_at (historically accurate)
 *     rather than now(). Falls back to now() if the parent match has no
 *     completed_at (shouldn't happen for terminal statuses but guarded anyway).
 *   - Logs every close with matchId, positionId, exitPrice, pnl, fallbackSource.
 *
 * Usage:
 *   cd apps/api && npx tsx src/scripts/close-orphan-positions.ts          # dry-run (prints plan, no UPDATEs)
 *   cd apps/api && npx tsx src/scripts/close-orphan-positions.ts --apply  # actually UPDATE
 *
 * Idempotent: already-closed positions are ignored by the WHERE clause.
 */

import "dotenv/config";
import { pool } from "../db/pool";
import { getSnapshot } from "../market/snapshotStore";

const TERMINAL_STATUSES = ["FORFEITED", "COMPLETED", "CANCELLED", "EXPIRED"];

interface OrphanRow {
    position_id: string;
    match_id: string;
    match_status: string;
    match_completed_at: string | null;
    pair_id: string;
    pair_symbol: string;
    pair_last_price: string | null;
    side: string;
    entry_price: string;
    qty: string;
}

async function main(): Promise<void> {
    const apply = process.argv.includes("--apply");
    console.log(`[close-orphan-positions] mode=${apply ? "APPLY" : "DRY-RUN"}\n`);

    // Find every orphan: open position attached to a terminal match.
    const { rows: orphans } = await pool.query<OrphanRow>(
        `SELECT mp.id AS position_id,
                mp.match_id,
                m.status AS match_status,
                m.completed_at AS match_completed_at,
                mp.pair_id,
                tp.symbol AS pair_symbol,
                tp.last_price AS pair_last_price,
                mp.side,
                mp.entry_price,
                mp.qty
         FROM match_positions mp
         JOIN matches m ON m.id = mp.match_id
         JOIN trading_pairs tp ON tp.id = mp.pair_id
         WHERE mp.closed_at IS NULL
           AND m.status = ANY($1)
         ORDER BY m.completed_at ASC NULLS LAST, mp.id ASC`,
        [TERMINAL_STATUSES],
    );

    if (orphans.length === 0) {
        console.log("[close-orphan-positions] No orphan positions found. Nothing to do.");
        await pool.end();
        return;
    }

    console.log(`[close-orphan-positions] Found ${orphans.length} orphan position(s).\n`);

    let closedCount = 0;
    let totalFallbackSnap = 0;
    let totalFallbackLastPrice = 0;
    let totalFallbackEntry = 0;

    for (const row of orphans) {
        // Resolve exit price via the same fallback chain forceCloseOpenPositions uses.
        let exitPrice: number | null = null;
        let fallbackSource: "snapshot" | "trading_pairs.last_price" | "entry_price" = "entry_price";

        // 1. Live snapshot (<60s old)
        const snap = await getSnapshot(row.pair_symbol, 60_000);
        if (snap) {
            const snapPrice = parseFloat(snap.last);
            if (Number.isFinite(snapPrice) && snapPrice > 0) {
                exitPrice = snapPrice;
                fallbackSource = "snapshot";
            }
        }

        // 2. trading_pairs.last_price
        if (exitPrice === null && row.pair_last_price !== null) {
            const lpNum = parseFloat(row.pair_last_price);
            if (Number.isFinite(lpNum) && lpNum > 0) {
                exitPrice = lpNum;
                fallbackSource = "trading_pairs.last_price";
            }
        }

        // 3. entry_price (flat close — lossless)
        if (exitPrice === null) {
            exitPrice = parseFloat(row.entry_price);
            fallbackSource = "entry_price";
        }

        const entryPrice = parseFloat(row.entry_price);
        const qty = parseFloat(row.qty);
        const pnl = row.side === "LONG"
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;

        // Historically accurate close time: match's completed_at if present,
        // otherwise fall back to now() (shouldn't happen for terminal statuses
        // but guarded defensively).
        const closedAt = row.match_completed_at ?? new Date().toISOString();

        const logEntry = {
            matchId: row.match_id,
            matchStatus: row.match_status,
            positionId: row.position_id,
            pairSymbol: row.pair_symbol,
            side: row.side,
            entryPrice,
            exitPrice,
            pnl: Number(pnl.toFixed(8)),
            fallbackSource,
            closedAt,
        };

        if (apply) {
            await pool.query(
                `UPDATE match_positions
                 SET exit_price = $2, pnl = $3, closed_at = $4
                 WHERE id = $1 AND closed_at IS NULL`,
                [row.position_id, exitPrice, pnl, closedAt],
            );
            console.log("[closed]", JSON.stringify(logEntry));
        } else {
            console.log("[would-close]", JSON.stringify(logEntry));
        }

        closedCount++;
        if (fallbackSource === "snapshot") totalFallbackSnap++;
        else if (fallbackSource === "trading_pairs.last_price") totalFallbackLastPrice++;
        else totalFallbackEntry++;
    }

    console.log(
        `\n[close-orphan-positions] ${apply ? "Closed" : "Would close"} ${closedCount} position(s).`,
    );
    console.log(
        `  via snapshot:              ${totalFallbackSnap}`,
    );
    console.log(
        `  via trading_pairs.last:    ${totalFallbackLastPrice}`,
    );
    console.log(
        `  via entry_price (lossless): ${totalFallbackEntry}`,
    );
    if (!apply) {
        console.log(
            "\n[close-orphan-positions] DRY-RUN — no rows updated. Re-run with --apply to commit.",
        );
    }

    await pool.end();
}

main().catch((err) => {
    console.error("[close-orphan-positions] failed:", err);
    process.exit(1);
});
