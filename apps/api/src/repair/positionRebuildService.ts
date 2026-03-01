import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, ZERO, toFixed8 } from "../utils/decimal";
import type { ComputedPosition, PositionDiff, RepairMode } from "./repairTypes";

// ── Types ──

export interface TradeRow {
  id: string;
  pair_id: string;
  price: string;
  qty: string;
  quote_amount: string;
  executed_at: string;
  user_side: "BUY" | "SELL";
  user_fee_bps: number;
}

// ── Fetch trades for a user+pair ──

const USER_TRADES_SQL = `
  SELECT
    t.id,
    t.pair_id,
    t.price::text     AS price,
    t.qty::text       AS qty,
    t.quote_amount::text AS quote_amount,
    t.executed_at,
    CASE
      WHEN buy_o.user_id = $1 THEN 'BUY'
      ELSE 'SELL'
    END AS user_side,
    CASE
      WHEN buy_o.user_id = $1 THEN
        CASE WHEN t.is_system_fill
               OR buy_o.created_at >= COALESCE(sell_o.created_at, '-infinity'::timestamptz)
             THEN tp.taker_fee_bps ELSE tp.maker_fee_bps END
      ELSE
        CASE WHEN t.is_system_fill
               OR sell_o.created_at >= COALESCE(buy_o.created_at, '-infinity'::timestamptz)
             THEN tp.taker_fee_bps ELSE tp.maker_fee_bps END
    END AS user_fee_bps
  FROM trades t
  LEFT JOIN orders buy_o  ON buy_o.id  = t.buy_order_id
  LEFT JOIN orders sell_o ON sell_o.id = t.sell_order_id
  JOIN trading_pairs tp   ON tp.id     = t.pair_id
  WHERE (buy_o.user_id = $1 OR sell_o.user_id = $1)
    AND t.pair_id = $2
    AND ($3::timestamptz IS NULL OR t.executed_at <= $3)
  ORDER BY t.executed_at ASC, t.id ASC
`;

export async function fetchUserTradesForPair(
  client: PoolClient,
  userId: string,
  pairId: string,
  toTs?: string,
): Promise<TradeRow[]> {
  const { rows } = await client.query<TradeRow>(USER_TRADES_SQL, [
    userId,
    pairId,
    toTs ?? null,
  ]);
  return rows;
}

// ── Deterministic replay ──

export function replayTrades(pairId: string, trades: TradeRow[]): ComputedPosition {
  let currentQty = ZERO;
  let avgEntry = ZERO;
  let realizedPnl = ZERO;
  let feesPaid = ZERO;
  let tradeCount = 0;

  for (const trade of trades) {
    const fillQty = D(trade.qty);
    const fillPrice = D(trade.price);
    const feeQuote = D(trade.quote_amount)
      .mul(D(trade.user_fee_bps))
      .div(D(10000));

    if (trade.user_side === "BUY") {
      const oldCost = currentQty.mul(avgEntry);
      const newCost = fillQty.mul(fillPrice);
      const totalQty = currentQty.plus(fillQty);

      if (totalQty.gt(ZERO)) {
        avgEntry = oldCost.plus(newCost).div(totalQty);
      }
      currentQty = totalQty;
    } else {
      // SELL: realize PnL on closed portion
      const closingQty = Decimal.min(fillQty, currentQty);

      if (closingQty.gt(ZERO)) {
        const pnl = closingQty.mul(fillPrice.minus(avgEntry));
        realizedPnl = realizedPnl.plus(pnl);
      }

      currentQty = currentQty.minus(fillQty);

      if (currentQty.lt(ZERO)) {
        // Flip to short
        avgEntry = fillPrice;
      } else if (currentQty.eq(ZERO)) {
        // Flat
        avgEntry = ZERO;
      }
      // Still long: avgEntry unchanged
    }

    feesPaid = feesPaid.plus(feeQuote);
    tradeCount++;
  }

  return {
    pairId,
    baseQty: toFixed8(currentQty),
    avgEntryPrice: toFixed8(avgEntry),
    realizedPnlQuote: toFixed8(realizedPnl),
    feesPaidQuote: toFixed8(feesPaid),
    tradeCount,
  };
}

// ── Compute position from trades ──

export async function computePositionFromTrades(
  client: PoolClient,
  params: { userId: string; pairId: string; toTs?: string },
): Promise<ComputedPosition> {
  const trades = await fetchUserTradesForPair(
    client,
    params.userId,
    params.pairId,
    params.toTs,
  );
  return replayTrades(params.pairId, trades);
}

// ── Diff current position vs computed ──

const EPS = D("0.00000001");

export async function diffPosition(
  client: PoolClient,
  userId: string,
  computed: ComputedPosition,
): Promise<PositionDiff[]> {
  const { rows } = await client.query<{
    base_qty: string;
    avg_entry_price: string;
    realized_pnl_quote: string;
    fees_paid_quote: string;
  }>(
    `SELECT base_qty::text, avg_entry_price::text, realized_pnl_quote::text, fees_paid_quote::text
     FROM positions
     WHERE user_id = $1 AND pair_id = $2`,
    [userId, computed.pairId],
  );

  const diffs: PositionDiff[] = [];

  if (rows.length === 0) {
    // No position row — everything is a diff if computed is non-zero
    const fields = [
      { field: "base_qty", expected: computed.baseQty },
      { field: "avg_entry_price", expected: computed.avgEntryPrice },
      { field: "realized_pnl_quote", expected: computed.realizedPnlQuote },
      { field: "fees_paid_quote", expected: computed.feesPaidQuote },
    ];
    for (const f of fields) {
      if (D(f.expected).abs().gt(EPS)) {
        diffs.push({
          pairId: computed.pairId,
          field: f.field,
          expected: f.expected,
          actual: "0.00000000",
        });
      }
    }
    return diffs;
  }

  const actual = rows[0];
  const checks: { field: string; expected: string; actual: string }[] = [
    { field: "base_qty", expected: computed.baseQty, actual: actual.base_qty },
    { field: "avg_entry_price", expected: computed.avgEntryPrice, actual: actual.avg_entry_price },
    { field: "realized_pnl_quote", expected: computed.realizedPnlQuote, actual: actual.realized_pnl_quote },
    { field: "fees_paid_quote", expected: computed.feesPaidQuote, actual: actual.fees_paid_quote },
  ];

  for (const c of checks) {
    if (D(c.expected).minus(D(c.actual)).abs().gt(EPS)) {
      diffs.push({
        pairId: computed.pairId,
        field: c.field,
        expected: c.expected,
        actual: c.actual,
      });
    }
  }

  return diffs;
}

// ── Apply rebuild ──

export async function applyPositionRebuildTx(
  client: PoolClient,
  params: {
    userId: string;
    pairId: string;
    computed: ComputedPosition;
    mode: RepairMode;
  },
): Promise<{ applied: boolean; diffs: PositionDiff[] }> {
  const diffs = await diffPosition(client, params.userId, params.computed);

  if (params.mode === "DRY_RUN" || diffs.length === 0) {
    return { applied: false, diffs };
  }

  // APPLY: upsert position to exact computed values
  await client.query(
    `INSERT INTO positions (user_id, pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, pair_id)
     DO UPDATE SET
       base_qty            = EXCLUDED.base_qty,
       avg_entry_price     = EXCLUDED.avg_entry_price,
       realized_pnl_quote  = EXCLUDED.realized_pnl_quote,
       fees_paid_quote     = EXCLUDED.fees_paid_quote,
       updated_at          = now()`,
    [
      params.userId,
      params.pairId,
      params.computed.baseQty,
      params.computed.avgEntryPrice,
      params.computed.realizedPnlQuote,
      params.computed.feesPaidQuote,
    ],
  );

  return { applied: true, diffs };
}
