/**
 * seed-demo-data.ts — Insert realistic demo match + trade data for test accounts.
 *
 * Usage:
 *   cd apps/api && npx tsx src/scripts/seed-demo-data.ts
 *   cd apps/api && npx tsx src/scripts/seed-demo-data.ts --cleanup
 *
 * Idempotent: checks for a sentinel match ID before inserting.
 * All seeded matches use a fixed set of UUIDs so cleanup is deterministic.
 */

import "dotenv/config";
import { Pool } from "pg";

// ── Config ──

const DATABASE_URL =
  process.env.DATABASE_PUBLIC_URL ||
  process.env.DATABASE_URL ||
  "postgresql://cp:cp@localhost:5433/cp";

const pool = new Pool({ connectionString: DATABASE_URL });

// Users (looked up dynamically, emails are stable)
const RTIRADO_EMAIL = "rtirado0607@gmail.com";
const DEMO_EMAIL = "demo@demo.local";

// Deterministic UUIDs for seeded data (prefixed with "deadbeef" for easy identification)
const MATCH_IDS = [
  "deadbeef-0001-4000-a000-000000000001",
  "deadbeef-0001-4000-a000-000000000002",
  "deadbeef-0001-4000-a000-000000000003",
  "deadbeef-0001-4000-a000-000000000004",
  "deadbeef-0001-4000-a000-000000000005",
  "deadbeef-0001-4000-a000-000000000006",
  "deadbeef-0001-4000-a000-000000000007",
  "deadbeef-0001-4000-a000-000000000008",
  "deadbeef-0001-4000-a000-000000000009",
  "deadbeef-0001-4000-a000-000000000010",
];

const SENTINEL_ID = MATCH_IDS[0];

// ── Helpers ──

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function hoursAfter(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600_000);
}

function minutesAfter(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

function positionId(matchIdx: number, posIdx: number): string {
  const m = String(matchIdx + 1).padStart(4, "0");
  const p = String(posIdx + 1).padStart(4, "0");
  return `deadbeef-0002-4000-a000-${m}0000${p}`;
}

function eloResultId(matchIdx: number): string {
  return MATCH_IDS[matchIdx];
}

function eloHistoryId(matchIdx: number, isWinner: boolean): string {
  const m = String(matchIdx + 1).padStart(4, "0");
  const w = isWinner ? "0001" : "0002";
  return `deadbeef-0003-4000-a000-${m}0000${w}`;
}

// ── Match definitions ──

interface MatchDef {
  daysAgo: number;
  winnerIsRtirado: boolean;
  winnerPnl: number;
  loserPnl: number;
  winnerTrades: number;
  loserTrades: number;
}

const MATCHES: MatchDef[] = [
  // rtirado wins 5
  { daysAgo: 28, winnerIsRtirado: true,  winnerPnl: 5.2,  loserPnl: -2.1,  winnerTrades: 4, loserTrades: 3 },
  { daysAgo: 24, winnerIsRtirado: true,  winnerPnl: 8.7,  loserPnl: -4.3,  winnerTrades: 5, loserTrades: 4 },
  { daysAgo: 20, winnerIsRtirado: true,  winnerPnl: 3.1,  loserPnl: -1.5,  winnerTrades: 3, loserTrades: 3 },
  { daysAgo: 14, winnerIsRtirado: true,  winnerPnl: 12.4, loserPnl: -6.8,  winnerTrades: 6, loserTrades: 5 },
  { daysAgo: 7,  winnerIsRtirado: true,  winnerPnl: 6.9,  loserPnl: -3.2,  winnerTrades: 4, loserTrades: 4 },
  // demo wins 5
  { daysAgo: 26, winnerIsRtirado: false, winnerPnl: 4.8,  loserPnl: -2.9,  winnerTrades: 4, loserTrades: 3 },
  { daysAgo: 22, winnerIsRtirado: false, winnerPnl: 7.3,  loserPnl: -5.1,  winnerTrades: 5, loserTrades: 4 },
  { daysAgo: 16, winnerIsRtirado: false, winnerPnl: 2.5,  loserPnl: -1.2,  winnerTrades: 3, loserTrades: 3 },
  { daysAgo: 10, winnerIsRtirado: false, winnerPnl: 14.8, loserPnl: -7.9,  winnerTrades: 7, loserTrades: 5 },
  { daysAgo: 3,  winnerIsRtirado: false, winnerPnl: 9.2,  loserPnl: -4.5,  winnerTrades: 5, loserTrades: 4 },
];

// ELO table (ROOKIE tier)
const ELO_WIN = 15;
const ELO_LOSE = -3;

// ── Position definitions for match trades ──

interface PosDef {
  pair: "BTC/USD" | "ETH/USD" | "SOL/USD";
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  durationMinutes: number;
}

function generatePositions(
  numWinner: number,
  numLoser: number,
  winnerPnl: number,
  loserPnl: number,
): { winner: PosDef[]; loser: PosDef[] } {
  const pairs: Array<"BTC/USD" | "ETH/USD" | "SOL/USD"> = ["BTC/USD", "ETH/USD", "SOL/USD"];
  const basePrices: Record<string, number> = { "BTC/USD": 67500, "ETH/USD": 2100, "SOL/USD": 87 };

  function makeTrades(count: number, totalPnlPct: number, capital: number): PosDef[] {
    const trades: PosDef[] = [];
    const avgPnlPerTrade = totalPnlPct / count;

    for (let i = 0; i < count; i++) {
      const pair = pairs[i % pairs.length]!;
      const base = basePrices[pair]!;
      const side: "LONG" | "SHORT" = i % 2 === 0 ? "LONG" : "SHORT";

      // Vary PnL per trade around the average
      const jitter = (Math.random() - 0.5) * Math.abs(avgPnlPerTrade) * 0.5;
      const tradePnlPct = avgPnlPerTrade + jitter;
      const priceDelta = base * (Math.abs(tradePnlPct) / 100);

      const tradeCapital = capital * (0.05 + Math.random() * 0.20); // 5-25% of capital
      const qty = tradeCapital / base;

      let entryPrice: number;
      let exitPrice: number;

      if (side === "LONG") {
        entryPrice = base + (Math.random() - 0.5) * base * 0.02;
        exitPrice = tradePnlPct > 0 ? entryPrice + priceDelta : entryPrice - priceDelta;
      } else {
        entryPrice = base + (Math.random() - 0.5) * base * 0.02;
        exitPrice = tradePnlPct > 0 ? entryPrice - priceDelta : entryPrice + priceDelta;
      }

      trades.push({
        pair,
        side,
        entryPrice: Math.round(entryPrice * 100) / 100,
        exitPrice: Math.round(exitPrice * 100) / 100,
        qty: Math.round(qty * 10000) / 10000,
        durationMinutes: 5 + Math.floor(Math.random() * 235), // 5 min to 4 hours
      });
    }
    return trades;
  }

  return {
    winner: makeTrades(numWinner, winnerPnl, 50000),
    loser: makeTrades(numLoser, loserPnl, 50000),
  };
}

// ── Seed ──

async function seed() {
  const client = await pool.connect();

  try {
    // Check idempotency
    const { rows: existing } = await client.query(
      `SELECT id FROM matches WHERE id = $1`,
      [SENTINEL_ID],
    );
    if (existing.length > 0) {
      console.log("Demo data already seeded (sentinel match exists). Use --cleanup first to re-seed.");
      return;
    }

    // Look up user IDs
    const { rows: users } = await client.query<{ id: string; email: string; elo_rating: number }>(
      `SELECT id, email, elo_rating FROM users WHERE email IN ($1, $2)`,
      [RTIRADO_EMAIL, DEMO_EMAIL],
    );
    const rtirado = users.find((u) => u.email === RTIRADO_EMAIL);
    const demo = users.find((u) => u.email === DEMO_EMAIL);
    if (!rtirado || !demo) {
      console.error("Users not found. Ensure both accounts exist.");
      return;
    }

    // Look up pair IDs
    const { rows: pairs } = await client.query<{ id: string; symbol: string }>(
      `SELECT id, symbol FROM trading_pairs WHERE symbol IN ('BTC/USD', 'ETH/USD', 'SOL/USD')`,
    );
    const pairMap = new Map(pairs.map((p) => [p.symbol, p.id]));
    if (pairMap.size < 3) {
      console.error("Missing trading pairs. Found:", [...pairMap.keys()]);
      return;
    }

    await client.query("BEGIN");

    // Track ELO progression
    let rtElo = rtirado.elo_rating;
    let dmElo = demo.elo_rating;
    let rtWins = 0, rtLosses = 0, rtStreak = 0, rtLossStreak = 0;
    let dmWins = 0, dmLosses = 0, dmStreak = 0, dmLossStreak = 0;

    let totalPositions = 0;

    for (let i = 0; i < MATCHES.length; i++) {
      const def = MATCHES[i]!;
      const matchId = MATCH_IDS[i]!;

      const winnerId = def.winnerIsRtirado ? rtirado.id : demo.id;
      const loserId = def.winnerIsRtirado ? demo.id : rtirado.id;
      const challengerId = rtirado.id; // rtirado always challenges
      const opponentId = demo.id;

      const winnerPnl = def.winnerIsRtirado ? def.winnerPnl : def.loserPnl;
      const loserPnl = def.winnerIsRtirado ? def.loserPnl : def.winnerPnl;
      const challengerPnl = def.winnerIsRtirado ? def.winnerPnl : def.loserPnl;
      const opponentPnl = def.winnerIsRtirado ? def.loserPnl : def.winnerPnl;
      const challengerTrades = def.winnerIsRtirado ? def.winnerTrades : def.loserTrades;
      const opponentTrades = def.winnerIsRtirado ? def.loserTrades : def.winnerTrades;

      const startedAt = daysAgo(def.daysAgo);
      const endsAt = hoursAfter(startedAt, 24);
      const completedAt = hoursAfter(startedAt, 23 + Math.random());

      // Insert match
      await client.query(
        `INSERT INTO matches (id, challenger_id, opponent_id, status, duration_hours, starting_capital,
           challenger_pnl_pct, opponent_pnl_pct, challenger_trades_count, opponent_trades_count,
           challenger_win_rate, opponent_win_rate, challenger_score, opponent_score,
           winner_id, elo_delta, elo_resolved, started_at, ends_at, completed_at, created_at)
         VALUES ($1,$2,$3,'COMPLETED',24,50000,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17)`,
        [
          matchId, challengerId, opponentId,
          challengerPnl, opponentPnl, challengerTrades, opponentTrades,
          60 + Math.random() * 30, 60 + Math.random() * 30, // win rates
          challengerPnl * 10, opponentPnl * 10, // scores (simplified)
          winnerId, ELO_WIN, startedAt, endsAt, completedAt, startedAt,
        ],
      );

      // ELO progression
      const winnerOldElo = def.winnerIsRtirado ? rtElo : dmElo;
      const loserOldElo = def.winnerIsRtirado ? dmElo : rtElo;
      const winnerNewElo = winnerOldElo + ELO_WIN;
      const loserNewElo = Math.max(0, loserOldElo + ELO_LOSE);

      if (def.winnerIsRtirado) {
        rtElo = winnerNewElo; dmElo = loserNewElo;
        rtWins++; rtStreak++; rtLossStreak = 0;
        dmLosses++; dmLossStreak++; dmStreak = 0;
      } else {
        dmElo = winnerNewElo; rtElo = loserNewElo;
        dmWins++; dmStreak++; dmLossStreak = 0;
        rtLosses++; rtLossStreak++; rtStreak = 0;
      }

      const winnerWinStreak = def.winnerIsRtirado ? rtStreak : dmStreak;
      const loserLossStreak = def.winnerIsRtirado ? dmLossStreak : rtLossStreak;

      // Badges
      const badges: string[] = [];
      if (winnerWinStreak === 3) badges.push("STREAK_3");
      if (winnerWinStreak === 5) badges.push("STREAK_5");

      // Insert match_elo_results
      await client.query(
        `INSERT INTO match_elo_results (match_id, winner_id, loser_id,
           winner_old_elo, winner_new_elo, winner_delta,
           loser_old_elo, loser_new_elo, loser_delta,
           winner_tier_before, winner_tier_after, loser_tier_before, loser_tier_after,
           winner_win_streak, loser_loss_streak, streak_multiplier, badges_earned, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          matchId, winnerId, loserId,
          winnerOldElo, winnerNewElo, ELO_WIN,
          loserOldElo, loserNewElo, ELO_LOSE,
          "ROOKIE", "ROOKIE", "ROOKIE", "ROOKIE",
          winnerWinStreak, loserLossStreak, 1.0,
          JSON.stringify(badges), completedAt,
        ],
      );

      // Insert elo_history
      await client.query(
        `INSERT INTO elo_history (id, user_id, old_elo, new_elo, change_reason, match_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [eloHistoryId(i, true), winnerId, winnerOldElo, winnerNewElo, "MATCH_WIN", matchId, completedAt],
      );
      await client.query(
        `INSERT INTO elo_history (id, user_id, old_elo, new_elo, change_reason, match_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [eloHistoryId(i, false), loserId, loserOldElo, loserNewElo, "MATCH_LOSS", matchId, completedAt],
      );

      // Insert badges
      for (const badge of badges) {
        await client.query(
          `INSERT INTO user_badges (user_id, badge_type, tier, metadata, earned_at)
           VALUES ($1, $2, 'ROOKIE', $3, $4)
           ON CONFLICT DO NOTHING`,
          [winnerId, badge, JSON.stringify({ matchId, streak: winnerWinStreak }), completedAt],
        );
      }

      // Insert match_positions (trades)
      const positions = generatePositions(def.winnerTrades, def.loserTrades, def.winnerPnl, def.loserPnl);

      let posIdx = 0;
      for (const pos of positions.winner) {
        const pairId = pairMap.get(pos.pair)!;
        const openedAt = minutesAfter(startedAt, 30 + posIdx * 60 + Math.floor(Math.random() * 30));
        const closedAt = minutesAfter(openedAt, pos.durationMinutes);
        const pnl = pos.side === "LONG"
          ? (pos.exitPrice - pos.entryPrice) * pos.qty
          : (pos.entryPrice - pos.exitPrice) * pos.qty;

        await client.query(
          `INSERT INTO match_positions (id, match_id, user_id, pair_id, side, entry_price, qty, exit_price, pnl, opened_at, closed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [positionId(i, posIdx), matchId, winnerId, pairId, pos.side,
           pos.entryPrice, pos.qty, pos.exitPrice, Math.round(pnl * 100) / 100,
           openedAt, closedAt],
        );
        posIdx++;
        totalPositions++;
      }

      for (const pos of positions.loser) {
        const pairId = pairMap.get(pos.pair)!;
        const openedAt = minutesAfter(startedAt, 30 + posIdx * 60 + Math.floor(Math.random() * 30));
        const closedAt = minutesAfter(openedAt, pos.durationMinutes);
        const pnl = pos.side === "LONG"
          ? (pos.exitPrice - pos.entryPrice) * pos.qty
          : (pos.entryPrice - pos.exitPrice) * pos.qty;

        await client.query(
          `INSERT INTO match_positions (id, match_id, user_id, pair_id, side, entry_price, qty, exit_price, pnl, opened_at, closed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [positionId(i, posIdx), matchId, loserId, pairId, pos.side,
           pos.entryPrice, pos.qty, pos.exitPrice, Math.round(pnl * 100) / 100,
           openedAt, closedAt],
        );
        posIdx++;
        totalPositions++;
      }
    }

    // Update user stats
    await client.query(
      `UPDATE users SET elo_rating = $1, win_count = $2, loss_count = $3, win_streak = $4, loss_streak = $5
       WHERE id = $6`,
      [rtElo, rtWins, rtLosses, rtStreak, rtLossStreak, rtirado.id],
    );
    await client.query(
      `UPDATE users SET elo_rating = $1, win_count = $2, loss_count = $3, win_streak = $4, loss_streak = $5
       WHERE id = $6`,
      [dmElo, dmWins, dmLosses, dmStreak, dmLossStreak, demo.id],
    );

    // Ensure user_tiers rows exist
    await client.query(
      `INSERT INTO user_tiers (user_id, tier) VALUES ($1, 'ROOKIE') ON CONFLICT (user_id) DO NOTHING`,
      [rtirado.id],
    );
    await client.query(
      `INSERT INTO user_tiers (user_id, tier) VALUES ($1, 'ROOKIE') ON CONFLICT (user_id) DO NOTHING`,
      [demo.id],
    );

    await client.query("COMMIT");

    // ── Summary ──
    console.log("\n=== DEMO DATA SEEDED ===\n");
    console.log(`Matches inserted:   ${MATCHES.length}`);
    console.log(`Positions inserted: ${totalPositions}`);
    console.log(`ELO history rows:   ${MATCHES.length * 2}`);
    console.log("");
    console.log(`rtirado (${rtirado.id}):`);
    console.log(`  ELO: ${rtirado.elo_rating} → ${rtElo}`);
    console.log(`  Record: ${rtWins}W ${rtLosses}L`);
    console.log(`  Streak: ${rtStreak > 0 ? rtStreak + "W" : rtLossStreak + "L"}`);
    console.log(`  Tier: ROOKIE`);
    console.log("");
    console.log(`demo (${demo.id}):`);
    console.log(`  ELO: ${demo.elo_rating} → ${dmElo}`);
    console.log(`  Record: ${dmWins}W ${dmLosses}L`);
    console.log(`  Streak: ${dmStreak > 0 ? dmStreak + "W" : dmLossStreak + "L"}`);
    console.log(`  Tier: ROOKIE`);

    // Verify ELO math
    const expectedRtElo = rtirado.elo_rating + (rtWins * ELO_WIN) + (rtLosses * ELO_LOSE);
    const expectedDmElo = demo.elo_rating + (dmWins * ELO_WIN) + (dmLosses * ELO_LOSE);
    console.log("");
    console.log(`ELO check (rtirado): expected=${expectedRtElo} actual=${rtElo} ${expectedRtElo === rtElo ? "✓" : "✗ MISMATCH"}`);
    console.log(`ELO check (demo):    expected=${expectedDmElo} actual=${dmElo} ${expectedDmElo === dmElo ? "✓" : "✗ MISMATCH"}`);

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Cleanup ──

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Delete match_positions for seeded matches
    await client.query(
      `DELETE FROM match_positions WHERE match_id = ANY($1)`,
      [MATCH_IDS],
    );
    const mp = await client.query(
      `SELECT count(*) AS c FROM match_positions WHERE match_id = ANY($1)`,
      [MATCH_IDS],
    );

    // Delete elo_history for seeded matches
    await client.query(
      `DELETE FROM elo_history WHERE match_id = ANY($1)`,
      [MATCH_IDS],
    );

    // Delete match_elo_results for seeded matches
    await client.query(
      `DELETE FROM match_elo_results WHERE match_id = ANY($1)`,
      [MATCH_IDS],
    );

    // Delete badges earned from seeded matches
    await client.query(
      `DELETE FROM user_badges WHERE metadata::text LIKE '%deadbeef%'`,
    );

    // Delete matches
    const del = await client.query(
      `DELETE FROM matches WHERE id = ANY($1) RETURNING id`,
      [MATCH_IDS],
    );

    // Reset user stats
    const { rows: users } = await client.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ($1, $2)`,
      [RTIRADO_EMAIL, DEMO_EMAIL],
    );
    for (const u of users) {
      await client.query(
        `UPDATE users SET elo_rating = 800, win_count = 0, loss_count = 0, win_streak = 0, loss_streak = 0
         WHERE id = $1`,
        [u.id],
      );
    }

    await client.query("COMMIT");
    console.log(`Cleaned up ${del.rowCount ?? 0} matches and all related data.`);
    console.log("Both users reset to ELO 800, 0W/0L.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Main ──

async function main() {
  try {
    if (process.argv.includes("--cleanup")) {
      await cleanup();
    } else {
      await seed();
    }
  } catch (err) {
    console.error("FAILED:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
