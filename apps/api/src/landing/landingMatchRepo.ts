/**
 * landingMatchRepo.ts — the only DB reads behind the public landing stream.
 * Selects just the columns the public payload needs; handles come from
 * display_name only (never the email-derived fallback other queries use).
 */

import Decimal from "decimal.js";
import { pool } from "../db/pool";
import type { PublicTrade } from "./featuredMatch";

export interface ActiveMatchRow {
  id: string;
  challenger_id: string;
  opponent_id: string;
  challenger_handle: string | null;
  opponent_handle: string | null;
  ends_at: Date;
  starting_capital: string;
}

export async function listActiveMatchesForLanding(limit = 50): Promise<ActiveMatchRow[]> {
  const { rows } = await pool.query<ActiveMatchRow>(
    `SELECT m.id, m.challenger_id, m.opponent_id,
            NULLIF(c.display_name, '') AS challenger_handle,
            NULLIF(o.display_name, '') AS opponent_handle,
            m.ends_at, m.starting_capital
       FROM matches m
       JOIN users c ON c.id = m.challenger_id
       JOIN users o ON o.id = m.opponent_id
      -- ends_at > now(): a match past its window but not yet closed by the
      -- completion job is over for the viewer; don't feature a 00:00:00 clock.
      WHERE m.status = 'ACTIVE' AND m.ends_at > now()
      ORDER BY m.started_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function lastMatchTrades(match: ActiveMatchRow, limit = 3): Promise<PublicTrade[]> {
  const { rows } = await pool.query<{ user_id: string; side: "BUY" | "SELL"; qty_filled: string; asset: string; at: Date }>(
    `SELECT o.user_id, o.side, o.qty_filled, split_part(tp.symbol, '/', 1) AS asset, o.updated_at AS at
       FROM orders o
       JOIN trading_pairs tp ON tp.id = o.pair_id
      WHERE o.match_id = $1 AND o.qty_filled > 0
      ORDER BY o.updated_at DESC
      LIMIT $2`,
    [match.id, limit],
  );
  return rows.map((r) => ({
    player: r.user_id === match.challenger_id ? "challenger" : "opponent",
    side: r.side,
    qty: new Decimal(r.qty_filled).toString(), // numeric(_,8) → "1", not "1.00000000"
    asset: r.asset,
    at: r.at.getTime(),
  }));
}
