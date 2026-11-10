/**
 * What a rejected order says to the user: the server's code + details as one
 * line, shown under the submit button until the next edit. The quote's
 * `reason` uses the same words, so the warning before the click and the
 * rejection after it read alike.
 */
import type { AxiosError } from "axios";

export type OrderErrorContext = {
  leveraged: boolean;
  /** The server's leverage cap for this order. */
  cap: number;
  /** Free USD (leveraged) or buying power. */
  available: number;
  /** The pair's max order notional, when known. */
  maxNotional: number | null;
  baseSymbol: string;
};

const fmtUsd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtWholeUsd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** $950, $992k, $5.00M: a chip's notional. */
export function fmtCompactUsd(n: number): string {
  if (n >= 999_500) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** An out-of-date tab: the server now needs what this build doesn't send. */
export const CLIENT_OUTDATED = "TRADR was updated — refresh to continue";

const TEXT: Record<string, string> = {
  scope_required: CLIENT_OUTDATED,
  book_stale_for_size: "Price feed stale — try a smaller order or retry",
  stale_price_source: "Price feed delayed — retry",
  reduce_only_no_position: "No position to reduce — it's already closed",
  leverage_mismatch: "Close the position to change leverage",
  spot_orders_open: "Cancel your open orders on this pair first",
  isolated_orders_open: "Cancel your open orders on this pair first",
  insufficient_liquidity: "Not enough liquidity — try a smaller order",
  pair_queue_overloaded: "Too many orders on this pair — retry in a moment",
  match_ended: "Match ended",
  competition_ended: "This competition has ended — it takes no more orders",
  POSITION_LIMIT: "Position limit reached",
  PAIR_DISABLED: "Pair disabled",
};
const RATE_LIMITED = "Too many requests — wait a moment and retry";

function textFor(code: string, details: { symbol?: string; maxNotional?: string } | undefined, ctx: OrderErrorContext): string | null {
  switch (code) {
    case "order_too_large": {
      const max = details?.maxNotional !== undefined ? Number(details.maxNotional) : ctx.maxNotional;
      const base = details?.symbol?.split("/")[0] ?? ctx.baseSymbol;
      return max !== null ? `Max order ${fmtWholeUsd(max)} on ${base}` : `Order too large for ${base}`;
    }
    case "insufficient_balance":
    case "insufficient_margin":
    case "INSUFFICIENT_BALANCE":
      return ctx.leveraged
        ? `Insufficient margin — ${fmtUsd(ctx.available)} free. Lower the size or leverage`
        : `Insufficient balance — ${fmtUsd(ctx.available)} available`;
    case "leverage_exceeds_cap":
      return `Leverage above your ${ctx.cap}x limit`;
    case "RATE_LIMITED":
    case "quota_exceeded":
      return RATE_LIMITED;
    default:
      return TEXT[code] ?? null;
  }
}

/** Why the quote won't fill (MarketQuote.reason). */
export function quoteReasonText(reason: string | null, ctx: OrderErrorContext): string {
  return (reason && textFor(reason, undefined, ctx)) ?? "Order can't be priced right now";
}

/**
 * Text for a failed POST /orders. Three body shapes reach here: the order
 * routes' { error, details }, the v1 routes' { code, message, details } and
 * the rate limiter's { statusCode, error: "Too Many Requests", message }.
 */
export function orderErrorText(err: unknown, ctx: OrderErrorContext): string {
  const res = (err as AxiosError).response;
  if (!res) return "Order failed — check your connection and retry";
  if (res.status === 429) return RATE_LIMITED;
  const data = (res.data ?? {}) as { code?: string; error?: string; message?: string; details?: { symbol?: string; maxNotional?: string } };
  const code = data.code ?? data.error ?? "";
  return textFor(code, data.details, ctx) ?? (data.message || "Order failed");
}
