import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import {
  createTrigger,
  listTriggers,
  cancelTrigger,
  createOco,
} from "@/api/endpoints/triggers";
import { useAppStore } from "@/stores/appStore";
import type {
  TriggerOrder,
  TriggerKind,
  OrderSide,
  TriggerStatus,
} from "@/types/api";
import { formatUsd, formatDecimal } from "@/lib/decimal";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

const TRIGGER_KINDS: TriggerKind[] = [
  "STOP_MARKET",
  "STOP_LIMIT",
  "TAKE_PROFIT_MARKET",
  "TAKE_PROFIT_LIMIT",
];

const STATUS_OPTIONS: (TriggerStatus | "ALL")[] = [
  "ALL",
  "ACTIVE",
  "TRIGGERED",
  "CANCELED",
  "EXPIRED",
  "FAILED",
];

function statusBadge(status: TriggerStatus) {
  const map: Record<
    TriggerStatus,
    { color: "blue" | "green" | "gray" | "red" | "yellow"; label: string }
  > = {
    ACTIVE: { color: "blue", label: "Active" },
    TRIGGERED: { color: "green", label: "Triggered" },
    CANCELED: { color: "gray", label: "Canceled" },
    EXPIRED: { color: "yellow", label: "Expired" },
    FAILED: { color: "red", label: "Failed" },
  };
  const { color, label } = map[status];
  return <Badge color={color}>{label}</Badge>;
}

function isLimitKind(kind: TriggerKind): boolean {
  return kind === "STOP_LIMIT" || kind === "TAKE_PROFIT_LIMIT";
}

export default function TriggersTab() {
  const pairs = useAppStore((s) => s.pairs);
  const pairMap = Object.fromEntries(pairs.map((p) => [p.id, p]));

  // Create trigger form state
  const [formPairId, setFormPairId] = useState("");
  const [formKind, setFormKind] = useState<TriggerKind>("STOP_MARKET");
  const [formSide, setFormSide] = useState<OrderSide>("BUY");
  const [formTriggerPrice, setFormTriggerPrice] = useState("");
  const [formLimitPrice, setFormLimitPrice] = useState("");
  const [formQty, setFormQty] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // OCO form state
  const [ocoOpen, setOcoOpen] = useState(false);
  const [ocoPairId, setOcoPairId] = useState("");
  const [ocoSide, setOcoSide] = useState<OrderSide>("SELL");
  const [ocoQty, setOcoQty] = useState("");
  const [ocoStopPrice, setOcoStopPrice] = useState("");
  const [ocoStopLimitPrice, setOcoStopLimitPrice] = useState("");
  const [ocoTpPrice, setOcoTpPrice] = useState("");
  const [ocoTpLimitPrice, setOcoTpLimitPrice] = useState("");
  const [ocoSubmitting, setOcoSubmitting] = useState(false);
  const [ocoError, setOcoError] = useState<string | null>(null);
  const [ocoSuccess, setOcoSuccess] = useState<TriggerOrder[] | null>(null);

  // Trigger list state
  const [triggers, setTriggers] = useState<TriggerOrder[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TriggerStatus | "ALL">(
    "ACTIVE",
  );
  const [canceling, setCanceling] = useState<string | null>(null);

  // Default pair selection
  useEffect(() => {
    if (pairs.length > 0 && !formPairId) {
      setFormPairId(pairs[0]!.id);
      setOcoPairId(pairs[0]!.id);
    }
  }, [pairs, formPairId]);

  // Fetch triggers
  const fetchTriggers = useCallback(
    async (cursor?: string) => {
      if (!cursor) setListLoading(true);
      try {
        const params: { status?: string; cursor?: string; limit: number } = {
          limit: 25,
        };
        if (statusFilter !== "ALL") params.status = statusFilter;
        if (cursor) params.cursor = cursor;
        const res = await listTriggers(params);
        if (cursor) {
          setTriggers((prev) => [...prev, ...res.data.data]);
        } else {
          setTriggers(res.data.data);
        }
        setNextCursor(res.data.nextCursor);
      } catch {
        // Non-fatal
      } finally {
        setListLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    fetchTriggers();
  }, [fetchTriggers]);

  // SSE event listeners for real-time updates
  useEffect(() => {
    function onFired(e: Event) {
      const detail = (e as CustomEvent).detail;
      setTriggers((prev) =>
        prev.map((t) =>
          t.id === detail.triggerId
            ? {
                ...t,
                status: "TRIGGERED" as TriggerStatus,
                derived_order_id: detail.derivedOrderId,
              }
            : t,
        ),
      );
    }
    function onCanceled(e: Event) {
      const detail = (e as CustomEvent).detail;
      setTriggers((prev) =>
        prev.map((t) =>
          t.id === detail.triggerId
            ? { ...t, status: "CANCELED" as TriggerStatus }
            : t,
        ),
      );
    }
    window.addEventListener("sse:trigger.fired", onFired);
    window.addEventListener("sse:trigger.canceled", onCanceled);
    return () => {
      window.removeEventListener("sse:trigger.fired", onFired);
      window.removeEventListener("sse:trigger.canceled", onCanceled);
    };
  }, []);

  // Submit create trigger
  async function handleCreateTrigger(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSubmitting(true);
    try {
      const res = await createTrigger({
        pairId: formPairId,
        kind: formKind,
        side: formSide,
        triggerPrice: formTriggerPrice,
        limitPrice: isLimitKind(formKind) ? formLimitPrice : undefined,
        qty: formQty,
      });
      setTriggers((prev) => [res.data, ...prev]);
      setFormTriggerPrice("");
      setFormLimitPrice("");
      setFormQty("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setFormError(message);
    } finally {
      setFormSubmitting(false);
    }
  }

  // Submit create OCO
  async function handleCreateOco(e: React.FormEvent) {
    e.preventDefault();
    setOcoError(null);
    setOcoSuccess(null);
    setOcoSubmitting(true);
    try {
      const stopKind = ocoStopLimitPrice ? "STOP_LIMIT" : "STOP_MARKET";
      const tpKind = ocoTpLimitPrice ? "TAKE_PROFIT_LIMIT" : "TAKE_PROFIT_MARKET";
      const res = await createOco({
        pairId: ocoPairId,
        legA: { kind: stopKind, side: ocoSide, triggerPrice: ocoStopPrice, limitPrice: ocoStopLimitPrice || undefined, qty: ocoQty },
        legB: { kind: tpKind, side: ocoSide, triggerPrice: ocoTpPrice, limitPrice: ocoTpLimitPrice || undefined, qty: ocoQty },
      });
      const ocoTriggers = [res.data.legA, res.data.legB];
      setOcoSuccess(ocoTriggers);
      setTriggers((prev) => [...ocoTriggers, ...prev]);
      setOcoStopPrice("");
      setOcoStopLimitPrice("");
      setOcoTpPrice("");
      setOcoTpLimitPrice("");
      setOcoQty("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setOcoError(message);
    } finally {
      setOcoSubmitting(false);
    }
  }

  // Cancel trigger
  async function handleCancel(triggerId: string) {
    setCanceling(triggerId);
    try {
      await cancelTrigger(triggerId);
      setTriggers((prev) =>
        prev.map((t) =>
          t.id === triggerId
            ? { ...t, status: "CANCELED" as TriggerStatus }
            : t,
        ),
      );
    } catch {
      // Non-fatal
    } finally {
      setCanceling(null);
    }
  }

  // Group OCO triggers by oco_group_id for visual linking
  const ocoGroups = new Set(
    triggers.filter((t) => t.oco_group_id).map((t) => t.oco_group_id!),
  );
  const ocoGroupColors = new Map<string, string>();
  const bgColors = [
    "bg-blue-900/10",
    "bg-purple-900/10",
    "bg-teal-900/10",
    "bg-amber-900/10",
  ];
  let colorIdx = 0;
  ocoGroups.forEach((gid) => {
    ocoGroupColors.set(gid, bgColors[colorIdx % bgColors.length]!);
    colorIdx++;
  });

  return (
    <div className="space-y-4">
      {/* Section 1: Create Trigger Form */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Create Trigger
        </h2>
        <form onSubmit={handleCreateTrigger} className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Pair</label>
              <select
                value={formPairId}
                onChange={(e) => setFormPairId(e.target.value)}
                className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              >
                {pairs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.symbol}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Kind</label>
              <select
                value={formKind}
                onChange={(e) => setFormKind(e.target.value as TriggerKind)}
                className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              >
                {TRIGGER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Side</label>
              <div className="flex rounded overflow-hidden border border-gray-700">
                {(["BUY", "SELL"] as OrderSide[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFormSide(s)}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                      formSide === s
                        ? s === "BUY"
                          ? "bg-green-600 text-white"
                          : "bg-red-600 text-white"
                        : "bg-gray-900 text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label="Trigger Price"
              placeholder="0.00"
              value={formTriggerPrice}
              onChange={(e) => setFormTriggerPrice(e.target.value)}
            />
            {isLimitKind(formKind) && (
              <Input
                label="Limit Price"
                placeholder="0.00"
                value={formLimitPrice}
                onChange={(e) => setFormLimitPrice(e.target.value)}
              />
            )}
            <Input
              label="Quantity"
              placeholder="0.00"
              value={formQty}
              onChange={(e) => setFormQty(e.target.value)}
            />
          </div>
          {formError && (
            <ErrorBanner
              message={formError}
              onDismiss={() => setFormError(null)}
            />
          )}
          <Button
            type="submit"
            loading={formSubmitting}
            disabled={!formPairId || !formTriggerPrice || !formQty}
          >
            Create Trigger
          </Button>
        </form>
      </Card>

      {/* Section 2: Create OCO Form (collapsible) */}
      <Card>
        <button
          onClick={() => setOcoOpen(!ocoOpen)}
          className="flex items-center gap-2 text-sm font-medium text-gray-300 w-full"
        >
          <span
            className={`transition-transform ${ocoOpen ? "rotate-90" : ""}`}
          >
            &#9654;
          </span>
          Create OCO (One-Cancels-Other)
        </button>
        {ocoOpen && (
          <form onSubmit={handleCreateOco} className="mt-4 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Pair</label>
                <select
                  value={ocoPairId}
                  onChange={(e) => setOcoPairId(e.target.value)}
                  className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                >
                  {pairs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.symbol}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Side</label>
                <div className="flex rounded overflow-hidden border border-gray-700">
                  {(["BUY", "SELL"] as OrderSide[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setOcoSide(s)}
                      className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                        ocoSide === s
                          ? s === "BUY"
                            ? "bg-green-600 text-white"
                            : "bg-red-600 text-white"
                          : "bg-gray-900 text-gray-400 hover:text-gray-200"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                label="Quantity"
                placeholder="0.00"
                value={ocoQty}
                onChange={(e) => setOcoQty(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-400">Stop Loss</p>
                <Input
                  label="Stop Trigger Price"
                  placeholder="0.00"
                  value={ocoStopPrice}
                  onChange={(e) => setOcoStopPrice(e.target.value)}
                />
                <Input
                  label="Stop Limit Price (optional)"
                  placeholder="0.00"
                  value={ocoStopLimitPrice}
                  onChange={(e) => setOcoStopLimitPrice(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-400">
                  Take Profit
                </p>
                <Input
                  label="Take Profit Trigger Price"
                  placeholder="0.00"
                  value={ocoTpPrice}
                  onChange={(e) => setOcoTpPrice(e.target.value)}
                />
                <Input
                  label="Take Profit Limit Price (optional)"
                  placeholder="0.00"
                  value={ocoTpLimitPrice}
                  onChange={(e) => setOcoTpLimitPrice(e.target.value)}
                />
              </div>
            </div>
            {ocoError && (
              <ErrorBanner
                message={ocoError}
                onDismiss={() => setOcoError(null)}
              />
            )}
            {ocoSuccess && (
              <div className="text-sm text-green-400">
                OCO created:{" "}
                {ocoSuccess.map((t) => t.kind.replace(/_/g, " ")).join(" + ")}
              </div>
            )}
            <Button
              type="submit"
              loading={ocoSubmitting}
              disabled={
                !ocoPairId || !ocoQty || !ocoStopPrice || !ocoTpPrice
              }
            >
              Create OCO
            </Button>
          </form>
        )}
      </Card>

      {/* Section 3: Triggers Table with filters */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">
            {statusFilter === "ACTIVE" ? "Active Triggers" : "Trigger History"}
          </h2>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as TriggerStatus | "ALL")
              }
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === "ALL" ? "All Statuses" : s}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              onClick={() => fetchTriggers()}
              disabled={listLoading}
            >
              Refresh
            </Button>
          </div>
        </div>

        {listLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : triggers.length === 0 ? (
          <EmptyState message="No triggers found" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-3">Pair</th>
                    <th className="pb-2 pr-3">Kind</th>
                    <th className="pb-2 pr-3">Side</th>
                    <th className="pb-2 pr-3 text-right">Trigger Price</th>
                    <th className="pb-2 pr-3 text-right">Limit Price</th>
                    <th className="pb-2 pr-3 text-right">Qty</th>
                    <th className="pb-2 pr-3">Status</th>
                    <th className="pb-2 pr-3">OCO</th>
                    <th className="pb-2 pr-3">Created</th>
                    <th className="pb-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {triggers.map((t) => {
                    const pair = pairMap[t.pair_id];
                    const rowBg = t.oco_group_id
                      ? ocoGroupColors.get(t.oco_group_id) ?? ""
                      : "";
                    return (
                      <tr
                        key={t.id}
                        className={`border-b border-gray-800/50 ${rowBg}`}
                      >
                        <td className="py-2 pr-3 font-medium">
                          {pair?.symbol ?? t.pair_id.slice(0, 8)}
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {t.kind.replace(/_/g, " ")}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={
                              t.side === "BUY"
                                ? "text-green-400"
                                : "text-red-400"
                            }
                          >
                            {t.side}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {formatUsd(t.trigger_price)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {t.limit_price ? formatUsd(t.limit_price) : "\u2014"}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {formatDecimal(t.qty, 8)}
                        </td>
                        <td className="py-2 pr-3">{statusBadge(t.status)}</td>
                        <td className="py-2 pr-3 text-xs text-gray-500">
                          {t.oco_group_id
                            ? t.oco_group_id.slice(0, 8)
                            : "\u2014"}
                        </td>
                        <td className="py-2 pr-3 text-xs text-gray-500">
                          {format(new Date(t.created_at), "MMM d HH:mm")}
                        </td>
                        <td className="py-2">
                          {t.status === "ACTIVE" && (
                            <Button
                              variant="danger"
                              onClick={() => handleCancel(t.id)}
                              loading={canceling === t.id}
                              className="text-xs px-2 py-1"
                            >
                              Cancel
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {nextCursor && (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="secondary"
                  onClick={() => fetchTriggers(nextCursor)}
                >
                  Load More
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
