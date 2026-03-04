import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  getOutboxStats,
  listOutbox,
  retryOutboxEvent,
  replayOutbox,
  type OutboxStats,
  type OutboxEvent,
} from "@/api/endpoints/admin";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

export default function AdminOutboxPage() {
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [events, setEvents] = useState<OutboxEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState("");
  const [retryLoading, setRetryLoading] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayResult, setReplayResult] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      getOutboxStats(),
      listOutbox({ status: filterStatus || undefined, limit: 25 }),
    ]).then(([statsRes, evtRes]) => {
      if (statsRes.status === "fulfilled") setStats(statsRes.value.data.stats);
      if (evtRes.status === "fulfilled") {
        setEvents(evtRes.value.data.events);
        setNextCursor(evtRes.value.data.nextCursor);
      }
      setLoading(false);
    });
  }, [filterStatus]);

  async function handleRetry(id: string) {
    setRetryLoading(id);
    try {
      await retryOutboxEvent(id);
      setEvents((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, status: "pending", retry_count: e.retry_count + 1 } : e,
        ),
      );
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setRetryLoading(null);
    }
  }

  async function handleReplay() {
    setReplayLoading(true);
    setReplayResult(null);
    try {
      const res = await replayOutbox();
      setReplayResult(res.data.replayed);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setReplayLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await listOutbox({
        status: filterStatus || undefined,
        cursor: nextCursor,
        limit: 25,
      });
      setEvents((prev) => [...prev, ...res.data.events]);
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

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <Card>
            <p className="text-xs text-gray-500">Total</p>
            <p className="text-lg font-semibold">{stats.total}</p>
          </Card>
          <Card>
            <p className="text-xs text-gray-500">Pending</p>
            <p className="text-lg font-semibold text-yellow-400">
              {stats.pending}
            </p>
          </Card>
          <Card>
            <p className="text-xs text-gray-500">Delivered</p>
            <p className="text-lg font-semibold text-green-400">
              {stats.delivered}
            </p>
          </Card>
          <Card>
            <p className="text-xs text-gray-500">Failed</p>
            <p className="text-lg font-semibold text-red-400">
              {stats.failed}
            </p>
          </Card>
        </div>
      )}

      {/* Events */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">Outbox Events</h2>
          <div className="flex gap-2">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
            </select>
            <Button
              variant="secondary"
              onClick={handleReplay}
              loading={replayLoading}
            >
              Replay Batch
            </Button>
          </div>
        </div>

        {replayResult !== null && (
          <div className="mb-3 text-sm text-green-400">
            Replayed {replayResult} events
          </div>
        )}

        {events.length === 0 ? (
          <EmptyState message="No outbox events" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-3">ID</th>
                    <th className="pb-2 pr-3">Type</th>
                    <th className="pb-2 pr-3">Status</th>
                    <th className="pb-2 pr-3">Retries</th>
                    <th className="pb-2 pr-3">Created</th>
                    <th className="pb-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((evt) => (
                    <tr
                      key={evt.id}
                      className="border-b border-gray-800/50"
                    >
                      <td className="py-2 pr-3 font-mono text-xs">
                        {evt.id.slice(0, 8)}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge color="gray">{evt.event_type}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge
                          color={
                            evt.status === "delivered"
                              ? "green"
                              : evt.status === "failed"
                                ? "red"
                                : "yellow"
                          }
                        >
                          {evt.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs">{evt.retry_count}</td>
                      <td className="py-2 pr-3 text-xs text-gray-500">
                        {format(new Date(evt.created_at), "MMM d HH:mm:ss")}
                      </td>
                      <td className="py-2">
                        {evt.status === "failed" && (
                          <Button
                            variant="secondary"
                            className="text-xs px-2 py-1"
                            onClick={() => handleRetry(evt.id)}
                            loading={retryLoading === evt.id}
                          >
                            Retry
                          </Button>
                        )}
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
