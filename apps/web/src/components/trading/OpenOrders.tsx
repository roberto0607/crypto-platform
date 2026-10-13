import { useState } from "react";
import Decimal from "decimal.js-light";
import { useTradingStore } from "@/stores/tradingStore";
import { formatDecimal } from "@/lib/decimal";
import type { TriggerOrder } from "@/types/api";

const TRIGGER_LABEL: Record<TriggerOrder["kind"], string> = {
  TAKE_PROFIT_MARKET: "Take profit",
  TAKE_PROFIT_LIMIT: "Take profit (limit)",
  STOP_MARKET: "Stop loss",
  STOP_LIMIT: "Stop loss (limit)",
  TRAILING_STOP_MARKET: "Trailing stop",
};

/**
 * Open-orders table — lives inside the trade-page OrderDock (`OrderDock.tsx`).
 * Styled with the `tr-` design system (reuses `.tr-ptbl` / `.tr-side-*`), not
 * generic Tailwind, so it matches the rest of the trade page. Reads the same
 * `openOrders` store slice that `refreshOpenOrders()` populates from
 * GET /orders?status=OPEN, and cancels via DELETE /orders/:id (optimistic
 * remove + revert handled in the store's `cancelOrder`).
 *
 * Below the orders, the pair's ACTIVE TP/SL/trailing triggers (`activeTriggers`
 * slice) with their own Cancel — so a trigger is never armed without the user
 * being able to see it and remove it.
 */
export default function OpenOrders() {
  const openOrders = useTradingStore((s) => s.openOrders);
  const cancelOrder = useTradingStore((s) => s.cancelOrder);
  const triggers = useTradingStore((s) => s.activeTriggers);
  const cancelTrigger = useTradingStore((s) => s.cancelTrigger);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function handleCancelTrigger(triggerId: string) {
    setCancellingId(triggerId);
    try {
      await cancelTrigger(triggerId);
    } catch {
      // Revert is handled in the store — just clear the spinner here.
    }
    setCancellingId(null);
  }

  async function handleCancel(orderId: string) {
    setCancellingId(orderId);
    try {
      await cancelOrder(orderId);
    } catch {
      // Revert is handled in the store — just clear the spinner here.
    }
    setCancellingId(null);
  }

  if (openOrders.length === 0 && triggers.length === 0) {
    return (
      <div className="tr-empty-state">
        <span className="tr-es-lbl">No open orders</span>
      </div>
    );
  }

  return (
    <>
    {openOrders.length > 0 && (
    <table className="tr-ptbl tr-oo-tbl">
      <thead>
        <tr>
          <th>Side</th>
          <th>Type</th>
          <th className="tr-oo-num">Price</th>
          <th className="tr-oo-num">Qty</th>
          <th className="tr-oo-num">Filled</th>
          <th>Status</th>
          <th className="tr-oo-act">Action</th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map((order) => {
          const filled = new Decimal(order.qty_filled);
          const total = new Decimal(order.qty);
          const pct = total.isZero() ? 0 : filled.div(total).mul(100).toNumber();
          const isBuy = order.side === "BUY";
          const cancelling = cancellingId === order.id;

          return (
            <tr key={order.id}>
              <td>
                <span className={isBuy ? "tr-side-b" : "tr-side-s"}>{order.side}</span>
              </td>
              <td className="tr-dim">{order.type}</td>
              <td className="tr-oo-num">
                {order.limit_price ? formatDecimal(order.limit_price, 2) : "MKT"}
              </td>
              <td className="tr-oo-num">{formatDecimal(order.qty, 6)}</td>
              <td className="tr-oo-num">
                <div className="tr-oo-fill">
                  <span>{formatDecimal(order.qty_filled, 6)}</span>
                  <div className="tr-oo-bar">
                    <div
                      className={`tr-oo-bar-f ${isBuy ? "buy" : "sell"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className="tr-dim">{order.status}</td>
              <td className="tr-oo-act">
                <button
                  type="button"
                  className="tr-oo-cancel"
                  onClick={() => handleCancel(order.id)}
                  disabled={cancelling}
                >
                  {cancelling ? "…" : "Cancel"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    )}
    {triggers.length > 0 && (
      <table className="tr-ptbl tr-oo-tbl" aria-label="Active triggers">
        <thead>
          <tr>
            <th>Side</th>
            <th>Trigger</th>
            <th className="tr-oo-num">Trigger price</th>
            <th className="tr-oo-num">Qty</th>
            <th>Linked</th>
            <th className="tr-oo-act">Action</th>
          </tr>
        </thead>
        <tbody>
          {triggers.map((t) => {
            const cancelling = cancellingId === t.id;
            const trailing = t.kind === "TRAILING_STOP_MARKET";
            return (
              <tr key={t.id}>
                <td>
                  <span className={t.side === "BUY" ? "tr-side-b" : "tr-side-s"}>{t.side}</span>
                </td>
                <td className="tr-dim">{TRIGGER_LABEL[t.kind] ?? t.kind}</td>
                <td className="tr-oo-num">
                  {formatDecimal(t.trigger_price, 2)}
                  {trailing && t.trailing_offset && (
                    <span className="tr-dim"> · trails {formatDecimal(t.trailing_offset, 2)}</span>
                  )}
                </td>
                <td className="tr-oo-num">{formatDecimal(t.qty, 6)}</td>
                <td className="tr-dim">{t.oco_group_id ? "OCO" : "—"}</td>
                <td className="tr-oo-act">
                  <button
                    type="button"
                    className="tr-oo-cancel"
                    onClick={() => handleCancelTrigger(t.id)}
                    disabled={cancelling}
                    aria-label={`Cancel ${TRIGGER_LABEL[t.kind] ?? t.kind}`}
                  >
                    {cancelling ? "…" : "Cancel"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
    </>
  );
}
