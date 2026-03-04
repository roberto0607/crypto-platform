import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  listEvents,
  getEvent,
  verifyEventChain,
  type StreamEvent,
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

export default function AdminEventStreamPage() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterEntityType, setFilterEntityType] = useState("");
  const [filterEntityId, setFilterEntityId] = useState("");

  // Event detail
  const [selectedEvent, setSelectedEvent] = useState<StreamEvent | null>(null);

  // Verify
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    valid: boolean;
    errors: string[];
  } | null>(null);

  useEffect(() => {
    setLoading(true);
    listEvents({
      entityType: filterEntityType || undefined,
      entityId: filterEntityId || undefined,
      limit: 25,
    })
      .then((res) => {
        setEvents(res.data.events);
        setNextCursor(res.data.nextCursor);
      })
      .catch(() => setError("Failed to load events"))
      .finally(() => setLoading(false));
  }, [filterEntityType, filterEntityId]);

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await listEvents({
        entityType: filterEntityType || undefined,
        entityId: filterEntityId || undefined,
        cursor: nextCursor,
        limit: 25,
      });
      setEvents((prev) => [...prev, ...res.data.events]);
      setNextCursor(res.data.nextCursor);
    } catch {
      // Non-fatal
    }
  }

  async function handleViewDetail(id: string) {
    if (selectedEvent?.id === id) {
      setSelectedEvent(null);
      return;
    }
    try {
      const res = await getEvent(id);
      setSelectedEvent(res.data.event);
    } catch {
      // Non-fatal
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await verifyEventChain();
      setVerifyResult({ valid: res.data.valid, errors: res.data.errors });
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setVerifying(false);
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">Event Stream</h2>
          <div className="flex gap-2">
            <Input
              placeholder="Entity Type"
              value={filterEntityType}
              onChange={(e) => setFilterEntityType(e.target.value)}
              className="w-32"
            />
            <Input
              placeholder="Entity ID"
              value={filterEntityId}
              onChange={(e) => setFilterEntityId(e.target.value)}
              className="w-40"
            />
            <Button
              variant="secondary"
              onClick={handleVerify}
              loading={verifying}
            >
              Verify Chain
            </Button>
          </div>
        </div>

        {verifyResult && (
          <div
            className={`mb-3 rounded border px-3 py-2 text-sm ${
              verifyResult.valid
                ? "border-green-800 bg-green-900/20 text-green-400"
                : "border-red-800 bg-red-900/20 text-red-400"
            }`}
          >
            {verifyResult.valid
              ? "Chain integrity verified"
              : `Chain errors: ${verifyResult.errors.join(", ")}`}
          </div>
        )}

        {events.length === 0 ? (
          <EmptyState message="No events" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-3">ID</th>
                    <th className="pb-2 pr-3">Type</th>
                    <th className="pb-2 pr-3">Entity</th>
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
                      <td className="py-2 pr-3 text-xs text-gray-400">
                        {evt.entity_type}:{evt.entity_id.slice(0, 8)}
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-500">
                        {format(new Date(evt.created_at), "MMM d HH:mm:ss")}
                      </td>
                      <td className="py-2">
                        <Button
                          variant="secondary"
                          className="text-xs px-2 py-1"
                          onClick={() => handleViewDetail(evt.id)}
                        >
                          {selectedEvent?.id === evt.id ? "Hide" : "View"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedEvent && (
              <pre className="mt-3 text-xs text-gray-300 bg-gray-800 rounded p-3 overflow-x-auto max-h-64">
                {JSON.stringify(selectedEvent.payload, null, 2)}
              </pre>
            )}

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
