import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  getLatestReconRun,
  runReconciliation,
  getReconReports,
  type ReconRun,
  type ReconReport,
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

export default function AdminReconciliationPage() {
  const [latestRun, setLatestRun] = useState<ReconRun | null>(null);
  const [reports, setReports] = useState<ReconReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterUserId, setFilterUserId] = useState("");
  const [filterSeverity, setFilterSeverity] = useState("");

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      getLatestReconRun(),
      getReconReports({
        userId: filterUserId || undefined,
        severity: filterSeverity || undefined,
        limit: 25,
      }),
    ]).then(([runRes, repRes]) => {
      if (runRes.status === "fulfilled") setLatestRun(runRes.value.data.run);
      if (repRes.status === "fulfilled") {
        setReports(repRes.value.data.reports);
        setNextCursor(repRes.value.data.nextCursor);
      }
      setLoading(false);
    });
  }, [filterUserId, filterSeverity]);

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await runReconciliation();
      setLatestRun(res.data.run);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setRunning(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await getReconReports({
        userId: filterUserId || undefined,
        severity: filterSeverity || undefined,
        cursor: nextCursor,
        limit: 25,
      });
      setReports((prev) => [...prev, ...res.data.reports]);
      setNextCursor(res.data.nextCursor);
    } catch {
      // Non-fatal
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

      {/* Latest Run */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">Latest Run</h2>
          <Button onClick={handleRun} loading={running}>
            Run Reconciliation
          </Button>
        </div>
        {latestRun ? (
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500">Status</p>
              <Badge
                color={latestRun.status === "completed" ? "green" : "yellow"}
              >
                {latestRun.status}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-gray-500">Started</p>
              <p className="text-gray-300">
                {format(new Date(latestRun.started_at), "MMM d HH:mm")}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Finished</p>
              <p className="text-gray-300">
                {latestRun.finished_at
                  ? format(new Date(latestRun.finished_at), "MMM d HH:mm")
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Findings</p>
              <p className="text-gray-300">{latestRun.findings_count}</p>
            </div>
          </div>
        ) : (
          <EmptyState message="No reconciliation runs yet" />
        )}
      </Card>

      {/* Reports */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">Reports</h2>
          <div className="flex gap-2">
            <Input
              placeholder="User ID"
              value={filterUserId}
              onChange={(e) => setFilterUserId(e.target.value)}
              className="w-40"
            />
            <select
              value={filterSeverity}
              onChange={(e) => setFilterSeverity(e.target.value)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
            >
              <option value="">All Severities</option>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </div>
        </div>
        {reports.length === 0 ? (
          <EmptyState message="No reports" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-3">User</th>
                    <th className="pb-2 pr-3">Severity</th>
                    <th className="pb-2 pr-3">Description</th>
                    <th className="pb-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} className="border-b border-gray-800/50">
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.user_id.slice(0, 8)}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge
                          color={
                            r.severity === "CRITICAL" || r.severity === "HIGH"
                              ? "red"
                              : r.severity === "MEDIUM"
                                ? "yellow"
                                : "gray"
                          }
                        >
                          {r.severity}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-300 max-w-xs truncate">
                        {r.description}
                      </td>
                      <td className="py-2 text-xs text-gray-500">
                        {format(new Date(r.created_at), "MMM d HH:mm")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor && (
              <div className="mt-3 flex justify-center">
                <Button variant="secondary" onClick={loadMore}>
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
