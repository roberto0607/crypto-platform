import { useState } from "react";
import Decimal from "decimal.js-light";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import { formatDecimal } from "@/lib/decimal";
import type { AxiosError } from "axios";
import type { V1ApiError } from "@/types/api";
import Spinner from "@/components/Spinner";

const QUICK_FILL = [0.25, 0.5, 0.75, 1] as const;

const ERROR_MAP: Record<string, string> = {
  insufficient_balance: "Insufficient balance",
  risk_check_failed: "Risk check failed",
  governance_check_failed: "Governance check failed",
  quota_exceeded: "Order limit exceeded",
  pair_queue_overloaded: "Queue full, retry shortly",
  trading_paused_global: "Trading is paused",
  trading_paused_pair: "Trading is paused for this pair",
};

export default function OrderForm() {
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const orderSide = useTradingStore((s) => s.orderSide);
  const orderType = useTradingStore((s) => s.orderType);
  const qty = useTradingStore((s) => s.qty);
  const limitPrice = useTradingStore((s) => s.limitPrice);
  const snapshot = useTradingStore((s) => s.snapshot);
  const orderSubmitting = useTradingStore((s) => s.orderSubmitting);
  const setOrderSide = useTradingStore((s) => s.setOrderSide);
  const setOrderType = useTradingStore((s) => s.setOrderType);
  const setQty = useTradingStore((s) => s.setQty);
  const setLimitPrice = useTradingStore((s) => s.setLimitPrice);
  const submitOrder = useTradingStore((s) => s.submitOrder);

  const pairs = useAppStore((s) => s.pairs);
  const wallets = useAppStore((s) => s.wallets);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const pair = pairs.find((p) => p.id === selectedPairId);
  if (!pair) {
    return <div className="text-sm text-gray-500 p-4">Select a pair to trade</div>;
  }

  const [baseSymbol, quoteSymbol] = pair.symbol.split("/") as [string, string];

  // Find wallets for base and quote assets
  const baseWallet = wallets.find((w) => w.asset_id === pair.base_asset_id);
  const quoteWallet = wallets.find((w) => w.asset_id === pair.quote_asset_id);
  const baseAvailable = baseWallet
    ? new Decimal(baseWallet.balance).minus(baseWallet.reserved)
    : new Decimal(0);
  const quoteAvailable = quoteWallet
    ? new Decimal(quoteWallet.balance).minus(quoteWallet.reserved)
    : new Decimal(0);

  // Effective price for estimates
  const effectivePrice =
    orderType === "LIMIT" && limitPrice
      ? safeDec(limitPrice)
      : snapshot?.last
        ? new Decimal(snapshot.last)
        : null;

  const qtyDec = safeDec(qty);

  // Estimated values
  const estimated = effectivePrice && qtyDec ? qtyDec.mul(effectivePrice) : null;
  const feeBps = new Decimal(pair.taker_fee_bps);
  const fee = estimated ? estimated.mul(feeBps).div(10_000) : null;
  const total = estimated && fee ? estimated.plus(fee) : null;

  // Max qty for quick-fill
  function maxBaseQty(): Decimal {
    if (orderSide === "SELL") return baseAvailable;
    if (!effectivePrice || effectivePrice.isZero()) return new Decimal(0);
    return quoteAvailable.div(effectivePrice);
  }

  function handleQuickFill(pct: number) {
    const max = maxBaseQty();
    const filled = max.mul(pct);
    setQty(filled.toFixed(8));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    // Client-side validation
    if (!qty || !safeDec(qty) || safeDec(qty)!.lte(0)) {
      setError("Quantity must be greater than 0");
      return;
    }
    if (orderType === "LIMIT" && (!limitPrice || !safeDec(limitPrice) || safeDec(limitPrice)!.lte(0))) {
      setError("Limit price is required for LIMIT orders");
      return;
    }

    try {
      const result = await submitOrder();
      const fillCount = result.fills.length;
      setSuccessMsg(
        `Order placed${fillCount > 0 ? ` — ${fillCount} fill${fillCount > 1 ? "s" : ""}` : ""}`,
      );
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err) {
      const axErr = err as AxiosError<V1ApiError | { error: string }>;
      const data = axErr.response?.data;
      if (data) {
        const code = "code" in data ? data.code : "error" in data ? data.error : "";
        const message = "message" in data ? data.message : "";
        setError(ERROR_MAP[code] ?? (message || "Order failed"));
      } else {
        setError("Order failed — check your connection");
      }
    }
  }

  const isBuy = orderSide === "BUY";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {/* Side toggle */}
      <div className="grid grid-cols-2 gap-1 rounded bg-gray-800 p-0.5">
        <button
          type="button"
          onClick={() => setOrderSide("BUY")}
          className={`rounded py-1.5 text-sm font-medium transition-colors ${
            isBuy ? "bg-green-600 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          BUY
        </button>
        <button
          type="button"
          onClick={() => setOrderSide("SELL")}
          className={`rounded py-1.5 text-sm font-medium transition-colors ${
            !isBuy ? "bg-red-600 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          SELL
        </button>
      </div>

      {/* Type toggle */}
      <div className="grid grid-cols-2 gap-1 rounded bg-gray-800 p-0.5">
        <button
          type="button"
          onClick={() => setOrderType("MARKET")}
          className={`rounded py-1 text-xs font-medium transition-colors ${
            orderType === "MARKET" ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          MARKET
        </button>
        <button
          type="button"
          onClick={() => {
            setOrderType("LIMIT");
            if (!limitPrice && snapshot?.last) setLimitPrice(snapshot.last);
          }}
          className={`rounded py-1 text-xs font-medium transition-colors ${
            orderType === "LIMIT" ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          LIMIT
        </button>
      </div>

      {/* Quantity */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">Quantity</label>
        <div className="flex items-center rounded border border-gray-700 bg-gray-900">
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent px-3 py-2 text-sm text-gray-100 outline-none"
          />
          <span className="pr-3 text-xs text-gray-500">{baseSymbol}</span>
        </div>
      </div>

      {/* Quick-fill buttons */}
      <div className="grid grid-cols-4 gap-1">
        {QUICK_FILL.map((pct) => (
          <button
            key={pct}
            type="button"
            onClick={() => handleQuickFill(pct)}
            className="rounded bg-gray-800 py-1 text-[10px] text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
          >
            {pct * 100}%
          </button>
        ))}
      </div>

      {/* Limit price (only for LIMIT) */}
      {orderType === "LIMIT" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Price</label>
          <div className="flex items-center rounded border border-gray-700 bg-gray-900">
            <input
              type="text"
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder="0.00"
              className="flex-1 bg-transparent px-3 py-2 text-sm text-gray-100 outline-none"
            />
            <span className="pr-3 text-xs text-gray-500">{quoteSymbol}</span>
          </div>
        </div>
      )}

      {/* Estimates */}
      <div className="border-t border-gray-800 pt-2 space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-500">Estimated</span>
          <span className="text-gray-300 font-mono">
            {estimated ? `~$${formatDecimal(estimated.toString(), 2)}` : "--"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Fee ({pair.taker_fee_bps} bps)</span>
          <span className="text-gray-300 font-mono">
            {fee ? `~$${formatDecimal(fee.toString(), 2)}` : "--"}
          </span>
        </div>
        <div className="flex justify-between font-medium">
          <span className="text-gray-400">Total</span>
          <span className="text-gray-200 font-mono">
            {total ? `~$${formatDecimal(total.toString(), 2)}` : "--"}
          </span>
        </div>
      </div>

      {/* Available balance hint */}
      <div className="text-[10px] text-gray-500">
        Available: {isBuy
          ? `${formatDecimal(quoteAvailable.toString(), 2)} ${quoteSymbol}`
          : `${formatDecimal(baseAvailable.toString(), 8)} ${baseSymbol}`}
      </div>

      {/* Error */}
      {error && <div className="rounded bg-red-900/30 border border-red-800 px-3 py-2 text-xs text-red-400">{error}</div>}

      {/* Success */}
      {successMsg && <div className="rounded bg-green-900/30 border border-green-800 px-3 py-2 text-xs text-green-400">{successMsg}</div>}

      {/* Submit */}
      <button
        type="submit"
        disabled={orderSubmitting || !qty}
        className={`rounded py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isBuy
            ? "bg-green-600 hover:bg-green-500 text-white"
            : "bg-red-600 hover:bg-red-500 text-white"
        }`}
      >
        {orderSubmitting ? (
          <Spinner size="sm" />
        ) : (
          `Place ${orderSide} Order`
        )}
      </button>
    </form>
  );
}

/** Safely parse a decimal string, returning null on invalid input */
function safeDec(val: string): Decimal | null {
  if (!val) return null;
  try {
    return new Decimal(val);
  } catch {
    return null;
  }
}
