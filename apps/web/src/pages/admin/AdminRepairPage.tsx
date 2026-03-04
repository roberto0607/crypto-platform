import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  repairDryRun,
  repairApply,
  reconcileUser,
  unquarantineIfClean,
  getRepairRuns,
  type RepairDiff,
  type RepairRun,
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

export default function AdminRepairPage() {
  const [userId, setUserId] = useState("");
  const [pairId, setPairId] = useState("");
  const [diff, setDiff] = useState<RepairDiff | null>(null);
  const [runs, setRuns] = useState<RepairRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getRepairRuns()
      .then((res) => setRuns(res.data.runs))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleDryRun() {
    if (!userId) return;
    setActionLoading("dryrun");
    setError(null);
    setDiff(null);
    try {
      const res = await repairDryRun(userId, pairId || undefined);
      setDiff(res.data.diff);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApply() {
    if (!userId) return;
    setActionLoading("apply");
    setError(null);
    try {
      await repairApply(userId, pairId || undefined);
      setSuccess("Repair applied successfully");
      setDiff(null);
      const res = await getRepairRuns();
      setRuns(res.data.runs);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReconcile() {
    if (!userId) return;
    setActionLoading("reconcile");
    setError(null);
    try {
      await reconcileUser(userId);
      setSuccess("User reconciled successfully");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleUnquarantine() {
    if (!userId) return;
    setActionLoading("unquarantine");
    setError(null);
    try {
      await unquarantineIfClean(userId);
      setSuccess("Unquarantine successful");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
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
      {success && (
        <div className="text-sm text-green-400 bg-green-900/20 border border-green-800 rounded px-4 py-2">
          {success}
          <button
            onClick={() => setSuccess(null)}
            className="ml-2 text-green-500 hover:text-green-300"
          >
            &times;
          </button>
        </div>
      )}

      {/* Dry Run Form */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Position Repair
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <Input
            label="User ID"
            placeholder="UUID"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          <Input
            label="Pair ID (optional)"
            placeholder="UUID"
            value={pairId}
            onChange={(e) => setPairId(e.target.value)}
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={handleDryRun}
            loading={actionLoading === "dryrun"}
            disabled={!userId}
          >
            Dry Run
          </Button>
          <Button
            variant="danger"
            onClick={handleApply}
            loading={actionLoading === "apply"}
            disabled={!userId || !diff}
          >
            Apply Repair
          </Button>
          <Button
            variant="secondary"
            onClick={handleReconcile}
            loading={actionLoading === "reconcile"}
            disabled={!userId}
          >
            Reconcile User
          </Button>
          <Button
            variant="secondary"
            onClick={handleUnquarantine}
            loading={actionLoading === "unquarantine"}
            disabled={!userId}
          >
            Unquarantine if Clean
          </Button>
        </div>
      </Card>

      {/* Diff Result */}
      {diff && (
        <Card>
          <h2 className="text-sm font-medium text-gray-300 mb-3">
            Dry Run Result
          </h2>
          {diff.positions.length === 0 ? (
            <EmptyState message="No differences found" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-3">Pair</th>
                    <th className="pb-2 pr-3">Computed</th>
                    <th className="pb-2 pr-3">Actual</th>
                    <th className="pb-2">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.positions.map((p) => (
                    <tr
                      key={p.pair_id}
                      className="border-b border-gray-800/50"
                    >
                      <td className="py-2 pr-3 font-mono text-xs">
                        {p.pair_id.slice(0, 8)}
                      </td>
                      <td className="py-2 pr-3">{p.computed}</td>
                      <td className="py-2 pr-3">{p.actual}</td>
                      <td className="py-2 font-medium text-yellow-400">
                        {p.delta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Repair History */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Repair Runs
        </h2>
        {runs.length === 0 ? (
          <EmptyState message="No repair runs" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">User</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Dry Run</th>
                  <th className="pb-2 pr-3">Findings</th>
                  <th className="pb-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {r.user_id.slice(0, 8)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        color={r.status === "completed" ? "green" : "yellow"}
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3">
                      {r.dry_run ? "Yes" : "No"}
                    </td>
                    <td className="py-2 pr-3">{r.findings}</td>
                    <td className="py-2 text-xs text-gray-500">
                      {format(new Date(r.created_at), "MMM d HH:mm")}
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
