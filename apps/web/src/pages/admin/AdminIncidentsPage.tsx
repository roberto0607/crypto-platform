import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  listIncidents,
  getIncident,
  getIncidentEvents,
  acknowledgeIncident,
  addIncidentNote,
  resolveIncident,
  getProofPack,
  type Incident,
  type IncidentEvent,
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

export default function AdminIncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");

  // Detail view
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Incident | null>(null);
  const [events, setEvents] = useState<IncidentEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [proofPack, setProofPack] = useState<Record<string, unknown> | null>(null);

  // Actions
  const [noteText, setNoteText] = useState("");
  const [resolveSummary, setResolveSummary] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    listIncidents({
      status: filterStatus || undefined,
      limit: 25,
    })
      .then((res) => {
        setIncidents(res.data.incidents);
        setNextCursor(res.data.nextCursor);
      })
      .catch(() => setError("Failed to load incidents"))
      .finally(() => setLoading(false));
  }, [filterStatus]);

  async function loadDetail(id: string) {
    if (selectedId === id) {
      setSelectedId(null);
      return;
    }
    setSelectedId(id);
    setDetailLoading(true);
    setProofPack(null);
    try {
      const [incRes, evtRes] = await Promise.all([
        getIncident(id),
        getIncidentEvents(id),
      ]);
      setDetail(incRes.data.incident);
      setEvents(evtRes.data.events);
    } catch {
      // Non-fatal
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleAcknowledge() {
    if (!selectedId || !noteText) return;
    setActionLoading(true);
    try {
      await acknowledgeIncident(selectedId, noteText);
      setNoteText("");
      await loadDetail(selectedId);
      // Refresh to get same ID expanded
      setSelectedId(null);
      setTimeout(() => loadDetail(selectedId!), 100);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAddNote() {
    if (!selectedId || !noteText) return;
    setActionLoading(true);
    try {
      await addIncidentNote(selectedId, noteText);
      setNoteText("");
      const evtRes = await getIncidentEvents(selectedId);
      setEvents(evtRes.data.events);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResolve() {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      let summary: Record<string, unknown> = {};
      if (resolveSummary) {
        try {
          summary = JSON.parse(resolveSummary);
        } catch {
          summary = { note: resolveSummary };
        }
      }
      await resolveIncident(selectedId, summary);
      setResolveSummary("");
      setSelectedId(null);
      // Refresh list
      const res = await listIncidents({ status: filterStatus || undefined, limit: 25 });
      setIncidents(res.data.incidents);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleLoadProofPack() {
    if (!selectedId) return;
    try {
      const res = await getProofPack(selectedId);
      setProofPack(res.data.proofPack);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setError(message);
    }
  }

  function severityColor(sev: string): "red" | "yellow" | "gray" {
    if (sev === "CRITICAL" || sev === "HIGH") return "red";
    if (sev === "MEDIUM") return "yellow";
    return "gray";
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
          <h2 className="text-sm font-medium text-gray-300">Incidents</h2>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
          >
            <option value="">All Statuses</option>
            <option value="OPEN">OPEN</option>
            <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
            <option value="RESOLVED">RESOLVED</option>
          </select>
        </div>

        {incidents.length === 0 ? (
          <EmptyState message="No incidents" />
        ) : (
          <div className="space-y-2">
            {incidents.map((inc) => (
              <div key={inc.id} className="border border-gray-800 rounded">
                <button
                  onClick={() => loadDetail(inc.id)}
                  className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-gray-800/30"
                >
                  <div className="flex items-center gap-3">
                    <Badge color={severityColor(inc.severity)}>
                      {inc.severity}
                    </Badge>
                    <Badge
                      color={
                        inc.status === "RESOLVED"
                          ? "green"
                          : inc.status === "ACKNOWLEDGED"
                            ? "yellow"
                            : "red"
                      }
                    >
                      {inc.status}
                    </Badge>
                    <span className="text-sm text-gray-300 truncate max-w-md">
                      {inc.description}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {format(new Date(inc.created_at), "MMM d HH:mm")}
                  </span>
                </button>

                {selectedId === inc.id && (
                  <div className="border-t border-gray-800 px-4 py-3 space-y-3">
                    {detailLoading ? (
                      <div className="flex justify-center py-4">
                        <Spinner />
                      </div>
                    ) : (
                      <>
                        {/* Event timeline */}
                        <div>
                          <p className="text-xs text-gray-500 mb-2">
                            Timeline ({events.length} events)
                          </p>
                          {events.length === 0 ? (
                            <p className="text-xs text-gray-600">No events</p>
                          ) : (
                            <div className="space-y-1">
                              {events.map((evt) => (
                                <div
                                  key={evt.id}
                                  className="flex items-start gap-2 text-xs"
                                >
                                  <span className="text-gray-500 whitespace-nowrap">
                                    {format(
                                      new Date(evt.created_at),
                                      "HH:mm:ss",
                                    )}
                                  </span>
                                  <Badge color="gray">{evt.kind}</Badge>
                                  <span className="text-gray-400">
                                    {evt.actor}
                                  </span>
                                  <span className="text-gray-500 truncate">
                                    {JSON.stringify(evt.payload)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        {detail && detail.status !== "RESOLVED" && (
                          <div className="space-y-2 border-t border-gray-800 pt-3">
                            <div className="flex items-end gap-2">
                              <Input
                                label="Note"
                                placeholder="Add note..."
                                value={noteText}
                                onChange={(e) => setNoteText(e.target.value)}
                                className="flex-1"
                              />
                              <Button
                                variant="secondary"
                                onClick={handleAddNote}
                                disabled={!noteText}
                                loading={actionLoading}
                                className="text-xs"
                              >
                                Add Note
                              </Button>
                              {detail.status === "OPEN" && (
                                <Button
                                  onClick={handleAcknowledge}
                                  disabled={!noteText}
                                  loading={actionLoading}
                                  className="text-xs"
                                >
                                  Acknowledge
                                </Button>
                              )}
                            </div>
                            <div className="flex items-end gap-2">
                              <Input
                                label="Resolve Summary (JSON or text)"
                                placeholder='{"resolved": true}'
                                value={resolveSummary}
                                onChange={(e) =>
                                  setResolveSummary(e.target.value)
                                }
                                className="flex-1"
                              />
                              <Button
                                variant="danger"
                                onClick={handleResolve}
                                loading={actionLoading}
                                className="text-xs"
                              >
                                Resolve
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Proof Pack */}
                        <div className="border-t border-gray-800 pt-3">
                          <Button
                            variant="secondary"
                            onClick={handleLoadProofPack}
                            className="text-xs"
                          >
                            Load Proof Pack
                          </Button>
                          {proofPack && (
                            <pre className="mt-2 text-xs text-gray-300 bg-gray-800 rounded p-3 overflow-x-auto max-h-64">
                              {JSON.stringify(proofPack, null, 2)}
                            </pre>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}

            {nextCursor && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const res = await listIncidents({
                      status: filterStatus || undefined,
                      cursor: nextCursor,
                      limit: 25,
                    });
                    setIncidents((prev) => [...prev, ...res.data.incidents]);
                    setNextCursor(res.data.nextCursor);
                  }}
                >
                  Load More
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
