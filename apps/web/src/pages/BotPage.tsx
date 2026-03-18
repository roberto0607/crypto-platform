import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import {
  startRun,
  pauseRun,
  resumeRun,
  stopRun,
  listRuns,
  getRun,
  getSignals,
} from "@/api/endpoints/bot";
import { getState as getReplayState } from "@/api/endpoints/replay";
import { useAppStore } from "@/stores/appStore";
import type {
  StrategyRun,
  StrategySignal,
  BotMode,
  BotStatus,
  UUID,
} from "@/types/api";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import EmptyState from "@/components/EmptyState";

function statusBadge(status: BotStatus) {
  const map: Record<
    BotStatus,
    { color: "green" | "yellow" | "gray" | "blue" | "red"; label: string }
  > = {
    RUNNING: { color: "green", label: "Running" },
    PAUSED: { color: "yellow", label: "Paused" },
    STOPPED: { color: "gray", label: "Stopped" },
    COMPLETED: { color: "blue", label: "Completed" },
    FAILED: { color: "red", label: "Failed" },
  };
  const { color, label } = map[status];
  return (
    <Badge color={color}>
      {status === "RUNNING" && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse mr-1" />
      )}
      {label}
    </Badge>
  );
}

function signalBadge(kind: StrategySignal["kind"]) {
  const map: Record<
    StrategySignal["kind"],
    { color: "green" | "red" | "blue" | "yellow" | "gray"; label: string }
  > = {
    ENTRY: { color: "green", label: "Entry" },
    EXIT: { color: "red", label: "Exit" },
    REGIME_CHANGE: { color: "blue", label: "Regime" },
    SETUP_DETECTED: { color: "yellow", label: "Setup" },
    SETUP_INVALIDATED: { color: "gray", label: "Invalidated" },
  };
  const { color, label } = map[kind];
  return <Badge color={color}>{label}</Badge>;
}

const STRATEGY_PARAMS = [
  { key: "adxThreshold", label: "ADX Threshold", placeholder: "25" },
  { key: "atrMultiplierSl", label: "ATR Multiplier SL", placeholder: "1.5" },
  {
    key: "atrMultiplierTrailing",
    label: "ATR Multiplier Trailing",
    placeholder: "2.0",
  },
  {
    key: "rMultipleTpTrend",
    label: "R-Multiple TP Trend",
    placeholder: "3.0",
  },
  {
    key: "rMultipleTpRange",
    label: "R-Multiple TP Range",
    placeholder: "1.5",
  },
  {
    key: "partialExitThreshold",
    label: "Partial Exit Threshold",
    placeholder: "0.5",
  },
  { key: "eqTolerance", label: "EQ Tolerance", placeholder: "0.02" },
  { key: "maxHoldingHours", label: "Max Holding Hours", placeholder: "48" },
];

export default function BotPage() {
  const pairs = useAppStore((s) => s.pairs);
  const pairMap = Object.fromEntries(pairs.map((p) => [p.id, p]));

  // Start run form
  const [formPairId, setFormPairId] = useState("");
  const [formMode, setFormMode] = useState<BotMode>("LIVE");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [strategyParams, setStrategyParams] = useState<
    Record<string, string>
  >({});
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [replayActive, setReplayActive] = useState<boolean | null>(null);
  const [replayChecking, setReplayChecking] = useState(false);

  // Runs list
  const [runs, setRuns] = useState<StrategyRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Run detail
  const [expandedRunId, setExpandedRunId] = useState<UUID | null>(null);
  const [expandedRun, setExpandedRun] = useState<StrategyRun | null>(null);
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [signalsCursor, setSignalsCursor] = useState<string | null>(null);
  const [signalsLoading, setSignalsLoading] = useState(false);

  // Default pair
  useEffect(() => {
    if (pairs.length > 0 && !formPairId) {
      setFormPairId(pairs[0]!.id);
    }
  }, [pairs, formPairId]);

  // Check replay state when REPLAY mode + pair changes
  useEffect(() => {
    if (formMode !== "REPLAY" || !formPairId) {
      setReplayActive(null);
      return;
    }
    let cancelled = false;
    setReplayChecking(true);
    getReplayState(formPairId)
      .then((res) => {
        if (!cancelled) {
          setReplayActive(res.data.session.is_active);
        }
      })
      .catch(() => {
        if (!cancelled) setReplayActive(false);
      })
      .finally(() => {
        if (!cancelled) setReplayChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formMode, formPairId]);

  // Fetch runs
  const fetchRuns = useCallback(async (cursor?: string) => {
    if (!cursor) setListLoading(true);
    try {
      const res = await listRuns(cursor ? { cursor, limit: 25 } : { limit: 25 });
      if (cursor) {
        setRuns((prev) => [...prev, ...res.data.runs]);
      } else {
        setRuns(res.data.runs);
      }
      setNextCursor(res.data.nextCursor);
    } catch {
      // Non-fatal
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Load run detail + signals
  async function loadRunDetail(runId: UUID) {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(runId);
    setSignalsLoading(true);
    try {
      const [runRes, sigRes] = await Promise.all([
        getRun(runId),
        getSignals(runId, { limit: 50 }),
      ]);
      setExpandedRun(runRes.data.run);
      setSignals(sigRes.data.signals);
      setSignalsCursor(sigRes.data.nextCursor);
    } catch {
      // Non-fatal
    } finally {
      setSignalsLoading(false);
    }
  }

  async function loadMoreSignals() {
    if (!expandedRunId || !signalsCursor) return;
    setSignalsLoading(true);
    try {
      const res = await getSignals(expandedRunId, {
        cursor: signalsCursor,
        limit: 50,
      });
      setSignals((prev) => [...prev, ...res.data.signals]);
      setSignalsCursor(res.data.nextCursor);
    } catch {
      // Non-fatal
    } finally {
      setSignalsLoading(false);
    }
  }

  // Start run
  async function handleStartRun(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSubmitting(true);
    try {
      const paramsJson: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(strategyParams)) {
        if (v.trim()) paramsJson[k] = parseFloat(v);
      }
      const res = await startRun({
        pairId: formPairId,
        mode: formMode,
        paramsJson: Object.keys(paramsJson).length > 0 ? paramsJson : undefined,
      });
      setRuns((prev) => [res.data.run, ...prev]);
      setStrategyParams({});
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setFormError(message);
    } finally {
      setFormSubmitting(false);
    }
  }

  // Run actions
  async function handleAction(
    runId: UUID,
    action: "pause" | "resume" | "stop",
  ) {
    setActionLoading(runId);
    try {
      const fn = { pause: pauseRun, resume: resumeRun, stop: stopRun }[action];
      const res = await fn(runId);
      setRuns((prev) =>
        prev.map((r) => (r.id === runId ? res.data.run : r)),
      );
      if (expandedRunId === runId) setExpandedRun(res.data.run);
    } catch {
      // Non-fatal
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Strategy Bot</h1>

      {/* Section 1: Start New Run */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Start New Run
        </h2>
        <form onSubmit={handleStartRun} className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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
              <label className="text-xs text-gray-500">Mode</label>
              <div className="flex rounded overflow-hidden border border-gray-700">
                {(["LIVE", "REPLAY"] as BotMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFormMode(m)}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                      formMode === m
                        ? "bg-blue-600 text-white"
                        : "bg-gray-900 text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {formMode === "REPLAY" && (
            <div className="text-sm">
              {replayChecking ? (
                <span className="text-gray-400">
                  Checking replay session...
                </span>
              ) : replayActive === false ? (
                <div className="flex items-center gap-2 text-yellow-400">
                  <span>
                    No active replay session for this pair.
                  </span>
                  <a
                    href="/replay"
                    className="underline hover:text-yellow-300"
                  >
                    Go to Replay
                  </a>
                </div>
              ) : replayActive === true ? (
                <span className="text-green-400">
                  Replay session active
                </span>
              ) : null}
            </div>
          )}

          {/* Advanced params */}
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200"
          >
            <span
              className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`}
            >
              &#9654;
            </span>
            Advanced Parameters
          </button>
          {advancedOpen && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {STRATEGY_PARAMS.map((p) => (
                <Input
                  key={p.key}
                  label={p.label}
                  placeholder={p.placeholder}
                  value={strategyParams[p.key] ?? ""}
                  onChange={(e) =>
                    setStrategyParams((prev) => ({
                      ...prev,
                      [p.key]: e.target.value,
                    }))
                  }
                />
              ))}
            </div>
          )}

          {formError && (
            <ErrorBanner
              message={formError}
              onDismiss={() => setFormError(null)}
            />
          )}
          <Button
            type="submit"
            loading={formSubmitting}
            disabled={
              !formPairId ||
              (formMode === "REPLAY" && replayActive !== true)
            }
          >
            Start Run
          </Button>
        </form>
      </Card>

      {/* Section 2: Active Runs */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">Runs</h2>
          <Button
            variant="secondary"
            onClick={() => fetchRuns()}
            disabled={listLoading}
          >
            Refresh
          </Button>
        </div>

        {listLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : runs.length === 0 ? (
          <EmptyState message="No strategy runs yet" />
        ) : (
          <div className="space-y-2">
            {runs.map((run) => {
              const pair = pairMap[run.pair_id];
              const isExpanded = expandedRunId === run.id;
              return (
                <div
                  key={run.id}
                  className="border border-gray-800 rounded-lg"
                >
                  {/* Run summary row */}
                  <button
                    onClick={() => loadRunDetail(run.id)}
                    className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <span className="font-medium text-sm">
                        {pair?.symbol ?? run.pair_id.slice(0, 8)}
                      </span>
                      <Badge
                        color={run.mode === "LIVE" ? "green" : "blue"}
                      >
                        {run.mode}
                      </Badge>
                      {statusBadge(run.status)}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span>
                        Started{" "}
                        {format(new Date(run.started_at), "MMM d HH:mm")}
                      </span>
                      {run.last_tick_ts && (
                        <span>
                          Last tick{" "}
                          {format(new Date(run.last_tick_ts), "HH:mm:ss")}
                        </span>
                      )}
                      <span className="text-gray-600">
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </div>
                  </button>

                  {/* Action buttons */}
                  {(run.status === "RUNNING" || run.status === "PAUSED") && (
                    <div className="px-4 pb-3 flex gap-2">
                      {run.status === "RUNNING" && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() => handleAction(run.id, "pause")}
                            loading={actionLoading === run.id}
                            className="text-xs"
                          >
                            Pause
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => handleAction(run.id, "stop")}
                            loading={actionLoading === run.id}
                            className="text-xs"
                          >
                            Stop
                          </Button>
                        </>
                      )}
                      {run.status === "PAUSED" && (
                        <>
                          <Button
                            variant="primary"
                            onClick={() => handleAction(run.id, "resume")}
                            loading={actionLoading === run.id}
                            className="text-xs"
                          >
                            Resume
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => handleAction(run.id, "stop")}
                            loading={actionLoading === run.id}
                            className="text-xs"
                          >
                            Stop
                          </Button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Section 3: Run Detail */}
                  {isExpanded && (
                    <div className="border-t border-gray-800 px-4 py-3 space-y-3">
                      {signalsLoading && !signals.length ? (
                        <div className="flex justify-center py-4">
                          <Spinner />
                        </div>
                      ) : (
                        <>
                          {expandedRun?.error_message && (
                            <ErrorBanner
                              message={expandedRun.error_message}
                            />
                          )}

                          {expandedRun?.params_json &&
                            Object.keys(expandedRun.params_json).length >
                              0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1">
                                  Parameters
                                </p>
                                <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-x-auto">
                                  {JSON.stringify(
                                    expandedRun.params_json,
                                    null,
                                    2,
                                  )}
                                </pre>
                              </div>
                            )}

                          <div>
                            <p className="text-xs text-gray-500 mb-2">
                              Signals ({signals.length})
                            </p>
                            {signals.length === 0 ? (
                              <EmptyState message="No signals yet" />
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                                      <th className="pb-2 pr-3">Time</th>
                                      <th className="pb-2 pr-3">Kind</th>
                                      <th className="pb-2 pr-3">Side</th>
                                      <th className="pb-2 pr-3">
                                        Confidence
                                      </th>
                                      <th className="pb-2">Payload</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {signals.map((sig) => (
                                      <tr
                                        key={sig.id}
                                        className="border-b border-gray-800/50"
                                      >
                                        <td className="py-1.5 pr-3 text-xs text-gray-400">
                                          {format(
                                            new Date(sig.ts),
                                            "MMM d HH:mm:ss",
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-3">
                                          {signalBadge(sig.kind)}
                                        </td>
                                        <td className="py-1.5 pr-3">
                                          {sig.side ? (
                                            <span
                                              className={
                                                sig.side === "BUY"
                                                  ? "text-green-400"
                                                  : "text-red-400"
                                              }
                                            >
                                              {sig.side}
                                            </span>
                                          ) : (
                                            <span className="text-gray-600">
                                              —
                                            </span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-3 text-xs">
                                          {sig.confidence ?? "—"}
                                        </td>
                                        <td className="py-1.5 text-xs text-gray-500 max-w-xs truncate">
                                          {JSON.stringify(sig.payload_json)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {signalsCursor && (
                              <div className="mt-2 flex justify-center">
                                <Button
                                  variant="secondary"
                                  onClick={loadMoreSignals}
                                  loading={signalsLoading}
                                  className="text-xs"
                                >
                                  Load More Signals
                                </Button>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {nextCursor && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="secondary"
                  onClick={() => fetchRuns(nextCursor)}
                >
                  Load More Runs
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
