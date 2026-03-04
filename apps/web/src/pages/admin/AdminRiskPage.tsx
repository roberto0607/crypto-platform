import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  getRiskLimits,
  upsertRiskLimit,
  getBreakers,
  resetBreaker,
  getQueueStats,
  type RiskLimit,
  type Breaker,
  type QueueStats,
} from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminRiskPage() {
  const [limits, setLimits] = useState<RiskLimit[]>([]);
  const [breakers, setBreakers] = useState<Breaker[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upsert form
  const [formLimitType, setFormLimitType] = useState("");
  const [formMaxValue, setFormMaxValue] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  const [resetLoading, setResetLoading] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([getRiskLimits(), getBreakers(), getQueueStats()]).then(
      ([limRes, brkRes, qRes]) => {
        if (limRes.status === "fulfilled") setLimits(limRes.value.data.limits);
        if (brkRes.status === "fulfilled")
          setBreakers(brkRes.value.data.breakers);
        if (qRes.status === "fulfilled")
          setQueueStats(qRes.value.data.stats);
        setLoading(false);
      },
    );
  }, []);

  async function handleUpsert(e: React.FormEvent) {
    e.preventDefault();
    setFormSubmitting(true);
    setError(null);
    try {
      await upsertRiskLimit({
        limitType: formLimitType,
        maxValue: parseFloat(formMaxValue),
      });
      const res = await getRiskLimits();
      setLimits(res.data.limits);
      setFormLimitType("");
      setFormMaxValue("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleResetBreaker(key: string) {
    setResetLoading(key);
    try {
      await resetBreaker(key);
      setBreakers((prev) => prev.filter((b) => b.breaker_key !== key));
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setResetLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* Risk Limits */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Risk Limits
        </h2>
        {limits.length === 0 ? (
          <EmptyState message="No risk limits configured" />
        ) : (
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Type</th>
                  <th className="pb-2 pr-3">User</th>
                  <th className="pb-2">Max Value</th>
                </tr>
              </thead>
              <tbody>
                {limits.map((l) => (
                  <tr key={l.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {l.limit_type}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {l.user_id ? l.user_id.slice(0, 8) : "Global"}
                    </td>
                    <td className="py-2">{l.max_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form onSubmit={handleUpsert} className="flex items-end gap-3">
          <Input
            label="Limit Type"
            placeholder="e.g. MAX_ORDER_SIZE"
            value={formLimitType}
            onChange={(e) => setFormLimitType(e.target.value)}
          />
          <Input
            label="Max Value"
            type="number"
            value={formMaxValue}
            onChange={(e) => setFormMaxValue(e.target.value)}
          />
          <Button
            type="submit"
            loading={formSubmitting}
            disabled={!formLimitType || !formMaxValue}
          >
            Upsert
          </Button>
        </form>
      </Card>

      {/* Circuit Breakers */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Circuit Breakers
        </h2>
        {breakers.length === 0 ? (
          <EmptyState message="No active breakers" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Key</th>
                  <th className="pb-2 pr-3">Reason</th>
                  <th className="pb-2 pr-3">Closes At</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {breakers.map((b) => (
                  <tr
                    key={b.breaker_key}
                    className="border-b border-gray-800/50"
                  >
                    <td className="py-2 pr-3 font-mono text-xs">
                      {b.breaker_key}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-400">
                      {b.reason ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {b.closes_at
                        ? format(new Date(b.closes_at), "MMM d HH:mm")
                        : "Manual"}
                    </td>
                    <td className="py-2">
                      <Button
                        variant="danger"
                        className="text-xs px-2 py-1"
                        onClick={() => handleResetBreaker(b.breaker_key)}
                        loading={resetLoading === b.breaker_key}
                      >
                        Reset
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Queue Stats */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Queue Stats
        </h2>
        {!queueStats || queueStats.pairs.length === 0 ? (
          <EmptyState message="No queue data" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Pair</th>
                  <th className="pb-2 pr-3">Depth</th>
                  <th className="pb-2">Processing</th>
                </tr>
              </thead>
              <tbody>
                {queueStats.pairs.map((p) => (
                  <tr key={p.pairId} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-medium">{p.symbol}</td>
                    <td className="py-2 pr-3">{p.depth}</td>
                    <td className="py-2">
                      <Badge color={p.processing ? "green" : "gray"}>
                        {p.processing ? "Active" : "Idle"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
