/**
 * leverage:liq-report — READ-ONLY review of the liquidations the engine did
 * not execute: LOG_ONLY rows (LIQUIDATION_MODE=log_only) and SKIPPED_STALE
 * rows (a breach seen while the pair's feed was stale). For each one: when,
 * who, which pair and side, the mark that tripped it, the liq price, what
 * LIQUIDATION_MODE=execute would have booked, and what the position is doing
 * now. Run it before switching to execute (docs/runbooks/leverage-liquidation-execute.md).
 *
 * "What execute would have done" is the engine's own settlement math
 * (isolatedPosition.applyIsolatedFill + computeFee, the taker rate) for a
 * close of the row's size at the row's mark. A real execute fills at the
 * touch (the bid for a long, the ask for a short), half the spread worse
 * than the mark, so its P&L differs from this by qty × half-spread.
 *
 * Everything runs in one READ ONLY transaction. Nothing is written.
 */
import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, toFixed8, ZERO } from "../utils/decimal";
import { computeFee } from "./feeCalc";
import { applyIsolatedFill } from "./isolatedPosition";

export type LiqReportArgs = {
    since: Date | null;
    userId: string | null;
    mode: "LOG_ONLY" | "SKIPPED_STALE" | null;
    json: boolean;
};

export function parseLiqReportArgs(argv: string[]): LiqReportArgs {
    const out: LiqReportArgs = { since: null, userId: null, mode: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a}: missing value`);
            return v;
        };
        if (a === "--json") out.json = true;
        else if (a === "--since") {
            const v = value();
            const d = new Date(v);
            if (Number.isNaN(d.getTime())) throw new Error(`--since: not a date: ${v}`);
            out.since = d;
        } else if (a === "--user") {
            const v = value();
            if (!/^[0-9a-f-]{36}$/i.test(v)) throw new Error(`--user: not a uuid: ${v}`);
            out.userId = v;
        } else if (a === "--mode") {
            const v = value().toUpperCase();
            if (v !== "LOG_ONLY" && v !== "SKIPPED_STALE") throw new Error(`--mode: LOG_ONLY or SKIPPED_STALE, got ${v}`);
            out.mode = v;
        } else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

export type WouldExecute = {
    /** The close priced at the mark (a real one fills at the touch). */
    fillPrice: string;
    /** After the loss cap. */
    realizedPnl: string;
    /** Taker fee, capped at what's left of the margin. */
    fee: string;
    /** Margin + P&L − fee back to the user's USD (never < 0). */
    returnedEquity: string;
    /** Loss past the margin (a gap), absorbed. */
    shortfall: string;
};

export type LiqReportRow = {
    id: string;
    createdAt: string;
    mode: "LOG_ONLY" | "SKIPPED_STALE";
    userId: string;
    email: string | null;
    pair: string;
    scope: { competitionId: string | null; matchId: string | null };
    epoch: number;
    side: "LONG" | "SHORT";
    qty: string;
    entry: string;
    leverage: string;
    margin: string;
    liqPrice: string;
    mark: string;
    bookAgeMs: number | null;
    /** Mark past the liq price, % of the liq price (> 0 = breached; how late/gapped it was seen). */
    pastLiqPct: string;
    wouldExecute: WouldExecute;
    /** The same position episode is still open now, closed since, or the row is not a breach at all (a bug). */
    now: "OPEN_SAME_EPOCH" | "CLOSED_OR_REOPENED";
    /** The row's mark doesn't breach its liq price: should never happen. */
    inconsistent: boolean;
};

export type LiqReport = {
    rows: LiqReportRow[];
    counts: { LOG_ONLY: number; SKIPPED_STALE: number; executed: number; openSameEpoch: number; inconsistent: number };
    totals: { wouldReturn: string; wouldShortfall: string };
};

type DbRow = {
    id: string; created_at: Date; mode: "LOG_ONLY" | "SKIPPED_STALE"; user_id: string; email: string | null;
    symbol: string; maker_fee_bps: number; taker_fee_bps: number; quote_asset_id: string;
    competition_id: string | null; match_id: string | null; position_epoch: number; side: "LONG" | "SHORT";
    qty: string; entry_price: string; leverage: string; margin: string; liq_price: string; mark_price: string;
    book_age_ms: number | null; now_epoch: number | null; now_qty: string | null;
};

/** What a close of the row's size at its mark would book, by the engine's math. */
export function wouldExecute(
    r: Pick<DbRow, "side" | "qty" | "entry_price" | "leverage" | "margin" | "liq_price" | "mark_price" | "user_id"
        | "maker_fee_bps" | "taker_fee_bps" | "quote_asset_id">,
): WouldExecute {
    const qty = D(r.qty);
    const mark = D(r.mark_price);
    const fee = D(computeFee(toFixed8(qty.mul(mark)), "TAKER", r, r.user_id).feeAmount);
    const state = {
        qty: r.side === "LONG" ? qty : qty.neg(),
        entry: D(r.entry_price),
        margin: D(r.margin),
        leverage: D(r.leverage),
        epoch: 0,
        liqPrice: D(r.liq_price),
    };
    const res = applyIsolatedFill(state, r.side === "LONG" ? "SELL" : "BUY", qty, mark, fee, state.leverage, 0);
    const s = res.reduce!.settlement;
    return {
        fillPrice: toFixed8(mark),
        realizedPnl: toFixed8(s.bookedPnl),
        fee: toFixed8(s.bookedFee),
        returnedEquity: toFixed8(s.credit),
        shortfall: toFixed8(s.shortfall),
    };
}

export async function buildLiqReport(client: PoolClient, args: LiqReportArgs): Promise<LiqReport> {
    const { rows } = await client.query<DbRow>(
        `SELECT l.id, l.created_at, l.mode, l.user_id, u.email, tp.symbol, tp.maker_fee_bps, tp.taker_fee_bps,
                tp.quote_asset_id, l.competition_id, l.match_id, l.position_epoch, l.side, l.qty::text,
                l.entry_price::text, l.leverage::text, l.margin::text, l.liq_price::text, l.mark_price::text,
                l.book_age_ms, p.epoch AS now_epoch, p.base_qty::text AS now_qty
         FROM liquidations l
         JOIN trading_pairs tp ON tp.id = l.pair_id
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN positions p
           ON p.user_id = l.user_id AND p.pair_id = l.pair_id
          AND p.competition_id IS NOT DISTINCT FROM l.competition_id
          AND p.match_id IS NOT DISTINCT FROM l.match_id
         WHERE l.mode IN ('LOG_ONLY', 'SKIPPED_STALE')
           AND ($1::timestamptz IS NULL OR l.created_at >= $1)
           AND ($2::uuid IS NULL OR l.user_id = $2)
           AND ($3::text IS NULL OR l.mode = $3)
         ORDER BY l.created_at, l.id`,
        [args.since, args.userId, args.mode],
    );
    const { rows: [ex] } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM liquidations
         WHERE mode = 'EXECUTED' AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::uuid IS NULL OR user_id = $2)`,
        [args.since, args.userId],
    );

    let wouldReturn = ZERO;
    let wouldShortfall = ZERO;
    const out: LiqReportRow[] = rows.map((r) => {
        const liq = D(r.liq_price);
        const mark = D(r.mark_price);
        const past = r.side === "LONG" ? liq.minus(mark) : mark.minus(liq);
        const w = wouldExecute(r);
        wouldReturn = wouldReturn.plus(w.returnedEquity);
        wouldShortfall = wouldShortfall.plus(w.shortfall);
        const open = r.now_epoch === r.position_epoch && r.now_qty !== null && !D(r.now_qty).isZero();
        return {
            id: r.id,
            createdAt: r.created_at.toISOString(),
            mode: r.mode,
            userId: r.user_id,
            email: r.email,
            pair: r.symbol,
            scope: { competitionId: r.competition_id, matchId: r.match_id },
            epoch: r.position_epoch,
            side: r.side,
            qty: r.qty,
            entry: r.entry_price,
            leverage: r.leverage,
            margin: r.margin,
            liqPrice: r.liq_price,
            mark: r.mark_price,
            bookAgeMs: r.book_age_ms,
            pastLiqPct: liq.isZero() ? "0.0000" : past.div(liq).mul(100).toFixed(4),
            wouldExecute: w,
            now: open ? "OPEN_SAME_EPOCH" : "CLOSED_OR_REOPENED",
            inconsistent: past.lt(0),
        };
    });
    return {
        rows: out,
        counts: {
            LOG_ONLY: out.filter((r) => r.mode === "LOG_ONLY").length,
            SKIPPED_STALE: out.filter((r) => r.mode === "SKIPPED_STALE").length,
            executed: ex.n,
            openSameEpoch: out.filter((r) => r.now === "OPEN_SAME_EPOCH").length,
            inconsistent: out.filter((r) => r.inconsistent).length,
        },
        totals: { wouldReturn: toFixed8(wouldReturn), wouldShortfall: toFixed8(wouldShortfall) },
    };
}

const usd = (s: string) => `$${new Decimal(s).toFixed(2)}`;
const scopeLabel = (s: LiqReportRow["scope"]) =>
    s.matchId ? `match ${s.matchId.slice(0, 8)}` : s.competitionId ? `comp ${s.competitionId.slice(0, 8)}` : "free-play";

export function formatLiqReport(rep: LiqReport, args: LiqReportArgs): string {
    const lines: string[] = [];
    const filters = [
        args.since ? `since ${args.since.toISOString()}` : null,
        args.userId ? `user ${args.userId}` : null,
        args.mode ? `mode ${args.mode}` : null,
    ].filter(Boolean).join(", ");
    lines.push(`Liquidations not executed (read-only)${filters ? ` — ${filters}` : ""}`);
    lines.push(
        `LOG_ONLY ${rep.counts.LOG_ONLY} · SKIPPED_STALE ${rep.counts.SKIPPED_STALE} · EXECUTED ${rep.counts.executed}` +
        ` · still open (same episode) ${rep.counts.openSameEpoch} · inconsistent ${rep.counts.inconsistent}`,
    );
    lines.push(`"Execute" = closed at the mark by the engine's math; a real execute fills at the touch (half the spread worse).\n`);
    if (rep.rows.length === 0) {
        lines.push("No LOG_ONLY or SKIPPED_STALE rows.");
        return lines.join("\n");
    }
    for (const r of rep.rows) {
        const w = r.wouldExecute;
        lines.push(
            `${r.createdAt}  ${r.mode.padEnd(13)} ${(r.email ?? r.userId).padEnd(30)} ${r.pair.padEnd(8)} ${scopeLabel(r.scope).padEnd(15)}` +
            ` ${r.leverage}x ${r.side.padEnd(5)} qty ${r.qty}  entry ${usd(r.entry)}  margin ${usd(r.margin)}`,
        );
        lines.push(
            `    mark ${usd(r.mark)}  liq ${usd(r.liqPrice)}  (${r.pastLiqPct}% past)  book age ${r.bookAgeMs ?? "—"} ms` +
            `  → execute: P&L ${usd(w.realizedPnl)}, fee ${usd(w.fee)}, returned ${usd(w.returnedEquity)}` +
            `${new Decimal(w.shortfall).gt(0) ? `, shortfall ${usd(w.shortfall)}` : ""}` +
            `  · now: ${r.now === "OPEN_SAME_EPOCH" ? "STILL OPEN" : "closed/reopened"}${r.inconsistent ? "  [INCONSISTENT: mark doesn't breach liq]" : ""}`,
        );
    }
    lines.push(`\nTotal execute would have returned ${usd(rep.totals.wouldReturn)}; shortfall absorbed ${usd(rep.totals.wouldShortfall)}.`);
    return lines.join("\n");
}
