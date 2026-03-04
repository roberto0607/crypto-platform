import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  listJobs,
  patchJob,
  runJob,
  type Job,
} from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminJobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listJobs()
      .then((res) => setJobs(res.data.jobs))
      .catch(() => setError("Failed to load jobs"))
      .finally(() => setLoading(false));
  }, []);

  async function handleToggle(name: string, enabled: boolean) {
    setActionLoading(name);
    try {
      const res = await patchJob(name, { enabled });
      setJobs((prev) => prev.map((j) => (j.name === name ? res.data.job : j)));
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRun(name: string) {
    setActionLoading(name);
    try {
      await runJob(name);
      // Refresh to get updated last_run
      const res = await listJobs();
      setJobs(res.data.jobs);
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
    <div className="space-y-4">
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      <Card>
        {jobs.length === 0 ? (
          <EmptyState message="No jobs configured" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Enabled</th>
                  <th className="pb-2 pr-3">Interval</th>
                  <th className="pb-2 pr-3">Last Run</th>
                  <th className="pb-2 pr-3">Last Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.name}
                    className="border-b border-gray-800/50"
                  >
                    <td className="py-2 pr-3 font-mono text-xs font-medium">
                      {job.name}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge color={job.enabled ? "green" : "gray"}>
                        {job.enabled ? "On" : "Off"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-400">
                      {(job.interval_ms / 1000).toFixed(0)}s
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {job.last_run_at
                        ? format(new Date(job.last_run_at), "MMM d HH:mm:ss")
                        : "Never"}
                    </td>
                    <td className="py-2 pr-3">
                      {job.last_status && (
                        <Badge
                          color={
                            job.last_status === "success"
                              ? "green"
                              : job.last_status === "error"
                                ? "red"
                                : "gray"
                          }
                        >
                          {job.last_status}
                        </Badge>
                      )}
                      {job.last_error && (
                        <span className="ml-1 text-xs text-red-400" title={job.last_error}>
                          !
                        </span>
                      )}
                    </td>
                    <td className="py-2 space-x-1">
                      <Button
                        variant={job.enabled ? "danger" : "primary"}
                        className="text-xs px-2 py-1"
                        onClick={() => handleToggle(job.name, !job.enabled)}
                        loading={actionLoading === job.name}
                      >
                        {job.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        variant="secondary"
                        className="text-xs px-2 py-1"
                        onClick={() => handleRun(job.name)}
                        loading={actionLoading === job.name}
                      >
                        Run Now
                      </Button>
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
