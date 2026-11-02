/**
 * What the open-position card derives from GET /positions and the mark
 * (display only; the server books every number for real).
 */
import Decimal from "decimal.js-light";
import { increasePosition, type MarginSide } from "@/lib/margin";

const BPS = 10000;

/**
 * The mark at which closing the whole position (a taker close at fee f)
 * gets back every fee paid on it: P&L − close fee − feesPaid = 0.
 *   long  (E·Q + F) / (Q·(1 − f))
 *   short (E·Q − F) / (Q·(1 + f))
 * f = the pair's taker fee (a MARKET close is always the taker).
 */
export function breakEvenPrice(p: {
  side: MarginSide;
  qty: number;
  entry: number;
  feesPaid: number;
  takerBps: number;
}): number | null {
  if (!(p.qty > 0) || !(p.entry > 0)) return null;
  const f = p.takerBps / BPS;
  const cost = p.entry * p.qty;
  return p.side === "LONG"
    ? (cost + p.feesPaid) / (p.qty * (1 - f))
    : (cost - p.feesPaid) / (p.qty * (1 + f));
}

/**
 * How far (in %) the mark can move against the position before it's
 * liquidated. Long (mark − liq) / mark, short (liq − mark) / mark; 0 once
 * past it; null without a liq price (a 1x long can't be liquidated).
 */
export function liqDistancePct(side: MarginSide, mark: number, liq: number | null): number | null {
  if (liq === null || !(liq > 0) || !(mark > 0)) return null;
  const d = side === "LONG" ? (mark - liq) / mark : (liq - mark) / mark;
  return Math.max(0, d * 100);
}

/** "3d 4h", "4h 12m", "11m", "<1m" since `openedAt`; null if unknown. */
export function openDuration(openedAt: string | null | undefined, now: number): string | null {
  if (!openedAt) return null;
  const t = Date.parse(openedAt);
  if (Number.isNaN(t)) return null;
  const mins = Math.floor(Math.max(0, now - t) / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/**
 * What the user keeps if the position is liquidated: its equity at the liq
 * price, which is the maintenance margin there (Q · liq · mmr). Approximate:
 * the engine closes at the book, a little past the liq price.
 */
export function equityAtLiq(qty: number, liq: number | null, mmrBps: number): number | null {
  if (liq === null || !(liq > 0)) return null;
  return qty * liq * (mmrBps / BPS);
}

/** The card's at-risk state: margin health in the red band (< 25%), and a liq price to hit. */
export function isAtRisk(health: number, liq: number | null): boolean {
  return liq !== null && liq > 0 && health < 0.25;
}

/**
 * The open ISOLATED position after adding `addQty` at `price`, booked the
 * way the engine books it (lib/margin increasePosition, shared cases with
 * the API). liqPrice null = can't be liquidated. null when nothing to add.
 */
export function addPreview(
  pos: { baseQty: string; entry: string; margin: string; leverage: string; mmrBps: number },
  addQty: string,
  price: number,
): { qty: number; entry: number; liqPrice: Decimal | null } | null {
  if (!addQty || !(Number(addQty) > 0) || !(price > 0)) return null;
  const signed = new Decimal(pos.baseQty);
  if (signed.isZero()) return null;
  const r = increasePosition(
    {
      side: signed.gt(0) ? "LONG" : "SHORT",
      qty: signed.abs(),
      entry: new Decimal(pos.entry),
      margin: new Decimal(pos.margin),
      mmrBps: pos.mmrBps,
    },
    new Decimal(addQty),
    new Decimal(price),
    new Decimal(pos.leverage),
  );
  return { qty: r.qty.toNumber(), entry: r.entry.toNumber(), liqPrice: r.liqPrice.gt(0) ? r.liqPrice : null };
}

/**
 * What an order on the other side does to an open position: bigger than it
 * closes it and opens the rest on the other side (flip), the same size
 * just closes it, smaller only reduces it.
 */
export function reverseSummary(p: { positionSide: MarginSide; positionQty: number; orderQty: number }): {
  kind: "flip" | "close" | "reduce";
  openSide: MarginSide;
  openQty: number;
} {
  const openSide: MarginSide = p.positionSide === "LONG" ? "SHORT" : "LONG";
  const rest = new Decimal(p.orderQty).minus(new Decimal(p.positionQty)).toDecimalPlaces(8).toNumber();
  if (rest > 0) return { kind: "flip", openSide, openQty: rest };
  return { kind: rest === 0 ? "close" : "reduce", openSide, openQty: 0 };
}
