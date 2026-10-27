/**
 * What the order panel and position card show for ISOLATED (leveraged)
 * trading, built on lib/margin.ts (the server's math, shared test cases).
 * Display only: the server decides the cap (GET /leverage) and books every
 * number for real.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §3, §4.
 */
import Decimal from "decimal.js-light";
import { liquidationPrice, marginHealth, sizeForMargin, type MarginSide } from "@/lib/margin";

const ZERO = new Decimal(0);
const BPS = 10000;

/** The selector's buttons: the usual steps, only those the server allows. */
export function leverageOptions(cap: number): number[] {
  const opts = [1, 2, 3, 5, 10].filter((l) => l <= cap);
  return opts.length > 0 ? opts : [1];
}

export type OrderPreview = {
  /** Base size sent as `qty` (8 dp, rounded down so the margin never exceeds what was entered). "" when nothing to send. */
  qty: string;
  notional: number;
  /** Taker fee on the notional (a LIMIT that rests pays the lower maker rate). */
  fee: number;
  /** null when it can't be liquidated (a 1x long) or nothing is entered. */
  liqPrice: Decimal | null;
  /** Liq price relative to the entry, in %. */
  liqDistancePct: number | null;
};

/** An ISOLATED order of `margin` USD at `leverage` from `price`. */
export function orderPreview(p: {
  margin: number;
  leverage: number;
  price: number;
  takerBps: number;
  mmrBps: number;
  side: MarginSide;
}): OrderPreview {
  const empty: OrderPreview = { qty: "", notional: 0, fee: 0, liqPrice: null, liqDistancePct: null };
  if (!(p.margin > 0) || !(p.price > 0) || !(p.leverage >= 1)) return empty;
  const price = new Decimal(p.price);
  const lev = new Decimal(p.leverage);
  const qty = sizeForMargin(new Decimal(p.margin), lev, price);
  if (qty.lte(0)) return empty;
  const notional = qty.mul(price);
  // The margin the engine locks for this fill: notional / L.
  const margin = notional.div(lev);
  const liq = liquidationPrice({ side: p.side, qty, entry: price, margin, mmrBps: p.mmrBps });
  const liqPrice = liq.gt(0) ? liq : null;
  return {
    qty: qty.toFixed(8),
    notional: notional.toNumber(),
    fee: notional.mul(p.takerBps).div(BPS).toNumber(),
    liqPrice,
    liqDistancePct: liqPrice ? liqPrice.div(price).minus(1).mul(100).toNumber() : null,
  };
}

/** The largest margin that, with the taker fee on its notional, fits in `free` USD. */
export function maxMargin(free: number, leverage: number, takerBps: number): number {
  if (!(free > 0)) return 0;
  return Math.floor((free / (1 + (leverage * takerBps) / BPS)) * 100) / 100;
}

export type IsolatedPositionView = {
  side: MarginSide;
  leverage: number;
  notional: number;
  margin: number;
  /** Loss capped at the margin (the position can't lose more). */
  unrealizedPnl: number;
  /** Return on margin, %. */
  roePct: number;
  /** 1 at entry → 0 at the liq price. */
  health: number;
  liqPrice: number | null;
};

/** An open ISOLATED position (GET /positions fields) at the live `mark`. */
export function isolatedPositionView(p: {
  baseQty: string;
  entry: string;
  margin: string;
  leverage: string;
  liqPrice: string | null;
  mmrBps: number;
  mark: number;
}): IsolatedPositionView {
  const signed = new Decimal(p.baseQty);
  const side: MarginSide = signed.gte(0) ? "LONG" : "SHORT";
  const qty = signed.abs();
  const entry = new Decimal(p.entry);
  const margin = new Decimal(p.margin);
  const mark = new Decimal(p.mark > 0 ? p.mark : 0);
  const raw = signed.mul(mark.minus(entry));
  const capped = raw.lt(margin.neg()) ? margin.neg() : raw;
  const health = p.mark > 0 && qty.gt(0)
    ? marginHealth({ side, qty, entry, margin, mmrBps: p.mmrBps }, mark).toNumber()
    : 1;
  return {
    side,
    leverage: Number(p.leverage),
    notional: qty.mul(entry).toNumber(),
    margin: margin.toNumber(),
    unrealizedPnl: capped.toNumber(),
    roePct: margin.gt(0) ? capped.div(margin).mul(100).toNumber() : 0,
    health,
    liqPrice: p.liqPrice === null ? null : Number(p.liqPrice),
  };
}

/** Margin-health colour band (§4): green > 50%, amber 25–50%, red < 25%. */
export function healthTone(health: number): "ok" | "warn" | "danger" {
  if (health > 0.5) return "ok";
  if (health >= 0.25) return "warn";
  return "danger";
}

export type EquityPosition = {
  pair_id: string;
  base_qty: string;
  avg_entry_price: string;
  margin_mode?: string;
  isolated_margin?: string;
};

/**
 * Equity of one account (free-play, or a match's own wallets): USD + each
 * open position's worth. ISOLATED: margin + uPnL, the loss capped at the
 * margin (the USD wallet no longer holds that margin). SPOT: base × mark.
 * The server's accountEquity.positionValue. null if a position has no mark.
 */
export function scopeEquity(
  usdBalance: number,
  positions: EquityPosition[],
  markOf: (pairId: string) => number | null | undefined,
): number | null {
  let total = new Decimal(usdBalance);
  for (const p of positions) {
    const qty = new Decimal(p.base_qty);
    if (qty.isZero()) continue;
    const m = markOf(p.pair_id);
    if (!(m && m > 0)) return null;
    const mark = new Decimal(m);
    if (p.margin_mode === "ISOLATED") {
      const margin = new Decimal(p.isolated_margin ?? "0");
      const upnl = qty.mul(mark.minus(new Decimal(p.avg_entry_price)));
      const worth = margin.plus(upnl);
      total = total.plus(worth.lt(ZERO) ? ZERO : worth);
    } else {
      total = total.plus(qty.mul(mark));
    }
  }
  return total.toNumber();
}

/** A mark.price older than this means the engine has gone quiet: shown as stale. */
export const MARK_FRESH_MS = 5_000;

export type PositionMark = {
  /** What the ISOLATED card shows and values the position at. */
  mark: number;
  /** The engine isn't liquidating on this pair right now (stale feed), or has gone quiet. */
  stale: boolean;
  /** engine = the liquidation engine's mark (Kraken book mid); ticker = no engine mark received. */
  source: "engine" | "ticker";
};

/**
 * The mark an ISOLATED position card uses: the liquidation engine's (SSE
 * mark.price, the same Kraken book mid liquidations are judged by) when one
 * has arrived. Paused, or silent for MARK_FRESH_MS: the last good engine
 * mark, flagged stale. None received (the engine is off, or not yet): the
 * ticker, not flagged.
 */
export function positionMark(
  entry: { mark: number | null; paused: boolean; receivedAt: number } | undefined,
  now: number,
  ticker: number,
): PositionMark {
  if (!entry) return { mark: ticker, stale: false, source: "ticker" };
  const stale = entry.paused || now - entry.receivedAt > MARK_FRESH_MS;
  if (entry.mark === null) return { mark: ticker, stale, source: "ticker" };
  return { mark: entry.mark, stale, source: "engine" };
}

/**
 * The chart's dashed liq-price line for the selected pair's position: an
 * open ISOLATED position with a liq price (a 1x long has none). SPOT
 * positions (leverage off) never get one.
 */
export function chartLiqPrice(position: { base_qty: string; margin_mode?: string; liq_price?: string | null } | null): number | null {
  if (!position || position.margin_mode !== "ISOLATED" || !position.liq_price) return null;
  if (Number(position.base_qty) === 0) return null;
  const liq = Number(position.liq_price);
  return liq > 0 ? liq : null;
}
