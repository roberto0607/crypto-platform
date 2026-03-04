import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  getRetentionStatus,
  getRetentionStats,
  runRetention,
  type RetentionStatus,
  type RetentionStats,
} from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminRetentionPage() {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [stats, setStats] = useState<RetentionStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([getRetentionStatus(), getRetentionStats()]).then(
      ([statusRes, statsRes]) => {
        if (statusRes.status === "fulfilled")
          setStatus(statusRes.value.data.status);
        if (statsRes.status === "fulfilled")
          setStats(statsRes.value.data.stats);
        setLoading(false);
      },
    );
  }, []);

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      await runRetention();
      const [statusRes, statsRes] = await Promise.all([
        getRetentionStatus(),
        getRetentionStats(),
      ]);
      setStatus(statusRes.data.status);
      setStats(statsRes.data.stats);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setRunning(false);
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

      {/* Status */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">
            Retention Status
          </h2>
          <Button onClick={handleRun} loading={running}>
            Run Now
          </Button>
        </div>
        {status ? (
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500">Enabled</p>
              <Badge color={status.enabled ? "green" : "gray"}>
                {status.enabled ? "Yes" : "No"}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-gray-500">Last Run</p>
              <p className="text-gray-300">
                {status.last_run_at
                  ? format(new Date(status.last_run_at), "MMM d HH:mm")
                  : "Never"}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Next Run</p>
              <p className="text-gray-300">
                {status.next_run_at
                  ? format(new Date(status.next_run_at), "MMM d HH:mm")
                  : "—"}
              </p>
            </div>
          </div>
        ) : (
          <EmptyState message="No retention status available" />
        )}
      </Card>

      {/* Table Sizes */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Table Sizes
        </h2>
        {stats.length === 0 ? (
          <EmptyState message="No stats available" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Table</th>
                  <th className="pb-2 pr-3 text-right">Rows</th>
                  <th className="pb-2 text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr
                    key={s.table_name}
                    className="border-b border-gray-800/50"
                  >
                    <td className="py-2 pr-3 font-mono text-xs">
                      {s.table_name}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {s.row_count.toLocaleString()}
                    </td>
                    <td className="py-2 text-right text-xs text-gray-400">
                      {(s.size_bytes / 1024).toFixed(1)} KB
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
