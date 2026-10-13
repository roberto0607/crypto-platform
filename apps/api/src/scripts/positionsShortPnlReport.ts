/**
 * positionsShortPnlReport.ts — READ-ONLY: what the short P&L bug left in the
 * positions table and in ended matches' P&L% / scores / winners.
 * Logic in analytics/shortPnlReport.ts. It writes nothing.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm positions:short-pnl-report                # every user
 *   pnpm positions:short-pnl-report --user <uuid>  # one user (positions only)
 *   pnpm positions:short-pnl-report --json         # machine-readable
 */
import "dotenv/config";
import { pool } from "../db/pool";
import {
    loadScopeFills,
    loadStoredPositions,
    loadEndedMatches,
    replayScopes,
    comparePositions,
    compareMatches,
    totalDelta,
    type PositionFinding,
} from "../analytics/shortPnlReport";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function scopeLabel(f: Pick<PositionFinding, "competition_id" | "match_id">): string {
    if (f.match_id) return `match ${f.match_id}`;
    if (f.competition_id) return `competition ${f.competition_id}`;
    return "free-play";
}

const usd = (s: string | null) => (s === null ? "—" : `$${Number(s).toFixed(2)}`);

async function main(): Promise<void> {
    const userId = arg("user") ?? null;
    if (userId && !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(`--user: not a uuid: ${userId}`);

    // Read-only by construction: one READ ONLY transaction.
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        const fills = await loadScopeFills(client, userId);
        const stored = await loadStoredPositions(client, userId);
        const matches = userId ? [] : await loadEndedMatches(client);
        const { rows: users } = await client.query<{ id: string; email: string }>(`SELECT id, email FROM users`);
        const { rows: pairs } = await client.query<{ id: string; symbol: string }>(`SELECT id, symbol FROM trading_pairs`);
        await client.query("COMMIT");

        const positions = comparePositions(stored, replayScopes(fills));
        const matchFindings = compareMatches(matches, stored, positions);

        if (process.argv.includes("--json")) {
            console.log(JSON.stringify({ positions, matches: matchFindings, total_delta_realized: totalDelta(positions) }, null, 2));
            return;
        }

        const email = new Map(users.map((u) => [u.id, u.email]));
        const symbol = new Map(pairs.map((p) => [p.id, p.symbol]));

        console.log(`Short P&L report (read-only)${userId ? ` — user ${userId}` : ""}`);
        console.log(`Stored positions rows vs a replay of their fills with the fixed math.`);
        console.log(`Not affected (not reported): wallets/ledger, equity, competition leaderboards, closed_trades journal.\n`);

        console.log(`── Positions (${positions.length}) ──`);
        if (positions.length === 0) console.log("No position row differs from its replay.");
        for (const f of positions) {
            const entry = f.stored_entry !== null && f.stored_entry !== f.correct_entry
                ? `  open entry ${usd(f.stored_entry)} → ${usd(f.correct_entry)} (qty ${f.base_qty})`
                : "";
            console.log(
                `  ${(email.get(f.user_id) ?? f.user_id).padEnd(32)} ${(symbol.get(f.pair_id) ?? f.pair_id).padEnd(9)} ${scopeLabel(f).padEnd(48)}` +
                ` realized ${usd(f.stored_realized)} → ${usd(f.correct_realized)} (Δ ${usd(f.delta_realized)})${entry}` +
                `${f.reliable ? "" : "  [UNRELIABLE: replayed qty ≠ stored qty]"}`,
            );
        }

        if (!userId) {
            console.log(`\n── Ended matches with an affected row (${matchFindings.length}) ──`);
            if (matchFindings.length === 0) console.log("No ended match used an affected row.");
            for (const m of matchFindings) {
                console.log(`match ${m.match_id}  ${m.status}  ended ${m.completed_at ?? "?"}${m.reliable ? "" : "  [UNRELIABLE]"}`);
                for (const p of [m.challenger, m.opponent]) {
                    console.log(
                        `  ${(email.get(p.user_id) ?? p.user_id).padEnd(32)} P&L ${p.stored_pnl_pct ?? "—"}% → ${p.correct_pnl_pct}%` +
                        `   score ${p.stored_score ?? "—"} → ${p.correct_score}`,
                    );
                }
                const who = (id: string | null) => (id ? email.get(id) ?? id : "draw");
                console.log(
                    m.winner_changes
                        ? `  WINNER WOULD CHANGE: ${who(m.stored_winner_id)} → ${who(m.correct_winner_id)}`
                        : `  winner unchanged (${who(m.stored_winner_id)}${m.status === "FORFEITED" ? ", by forfeit rule" : ""})`,
                );
            }
        }

        const reliable = positions.filter((f) => f.reliable);
        const flips = matchFindings.filter((m) => m.winner_changes).length;
        console.log(
            `\n${positions.length} position row(s) differ (${positions.length - reliable.length} unreliable); ` +
            `net realized correction ${usd(totalDelta(positions))} over reliable rows` +
            `${userId ? "" : `; ${matchFindings.length} ended match(es) affected, ${flips} winner change(s)`}. Nothing was changed.`,
        );
    } finally {
        client.release();
    }
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error(err instanceof Error ? err.message : err);
        await pool.end().catch(() => {});
        process.exit(1);
    });
