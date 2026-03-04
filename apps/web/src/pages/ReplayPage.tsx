import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import {
  start as startReplay,
  pause as pauseReplay,
  resume as resumeReplay,
  seek as seekReplay,
  stop as stopReplay,
  getState as getReplayState,
} from "@/api/endpoints/replay";
import { useAppStore } from "@/stores/appStore";
import type { ReplaySession } from "@/types/api";
import { normalizeApiError } from "@/lib/errors";
import { AxiosError } from "axios";
import Card from "@/components/Card";
import Button from "@/components/Button";
import Input from "@/components/Input";
import Badge from "@/components/Badge";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

export default function ReplayPage() {
  const pairs = useAppStore((s) => s.pairs);

  // Active session state
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Start form state
  const [formPairId, setFormPairId] = useState("");
  const [formStart, setFormStart] = useState("");
  const [formTimeframe, setFormTimeframe] = useState("15m");
  const [formSpeed, setFormSpeed] = useState("1");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Seek state
  const [seekTs, setSeekTs] = useState("");

  // Default pair
  useEffect(() => {
    if (pairs.length > 0 && !formPairId) {
      setFormPairId(pairs[0]!.id);
    }
  }, [pairs, formPairId]);

  // Check for active session on mount
  const checkSession = useCallback(async () => {
    setSessionLoading(true);
    try {
      const res = await getReplayState();
      if (res.data.session.is_active) {
        setSession(res.data.session);
      } else {
        setSession(null);
      }
    } catch {
      setSession(null);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // SSE replay.tick updates current time
  useEffect(() => {
    function onReplayTick(e: Event) {
      const detail = (e as CustomEvent).detail;
      setSession((prev) => {
        if (!prev) return prev;
        return { ...prev, current_ts: String(detail.sessionTs) };
      });
    }
    window.addEventListener("sse:replay.tick", onReplayTick);
    return () => window.removeEventListener("sse:replay.tick", onReplayTick);
  }, []);

  // Start session
  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSubmitting(true);
    try {
      const res = await startReplay({
        pairId: formPairId,
        timeframe: formTimeframe,
        speed: formSpeed,
      });
      setSession(res.data.session);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setFormError(message);
    } finally {
      setFormSubmitting(false);
    }
  }

  // Session actions
  async function handlePause() {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await pauseReplay();
      setSession(res.data.session);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setActionError(message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResume() {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await resumeReplay();
      setSession(res.data.session);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setActionError(message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSeek() {
    if (!seekTs) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await seekReplay(seekTs);
      setSession(res.data.session);
      setSeekTs("");
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setActionError(message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStop() {
    setActionLoading(true);
    setActionError(null);
    try {
      await stopReplay();
      setSession(null);
    } catch (err) {
      const { message } = normalizeApiError(err as AxiosError<never>);
      setActionError(message);
    } finally {
      setActionLoading(false);
    }
  }

  const pairMap = Object.fromEntries(pairs.map((p) => [p.id, p]));

  if (sessionLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Replay</h1>

      {/* Active Session Panel */}
      {session && (
        <Card>
          <div className="space-y-4">
            {/* Header row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-medium">
                  {pairMap[session.pair_id]?.symbol ?? session.pair_id.slice(0, 8)}
                </span>
                <Badge color={session.is_paused ? "yellow" : "green"}>
                  {session.is_paused ? "Paused" : "Active"}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>Speed: {session.speed}x</span>
                <span>Timeframe: {session.timeframe}</span>
              </div>
            </div>

            {/* Current time display */}
            <div className="text-center py-4">
              <p className="text-xs text-gray-500 mb-1">Current Time</p>
              <p className="text-2xl font-mono text-gray-100">
                {isNaN(Number(session.current_ts))
                  ? session.current_ts
                  : format(new Date(Number(session.current_ts)), "yyyy-MM-dd HH:mm:ss")}
              </p>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-3">
              {session.is_paused ? (
                <Button
                  onClick={handleResume}
                  loading={actionLoading}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={handlePause}
                  loading={actionLoading}
                >
                  Pause
                </Button>
              )}
              <Button
                variant="danger"
                onClick={handleStop}
                loading={actionLoading}
              >
                Stop
              </Button>
            </div>

            {/* Seek controls */}
            <div className="flex items-end gap-2">
              <Input
                label="Seek to timestamp"
                type="datetime-local"
                value={seekTs}
                onChange={(e) => setSeekTs(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="secondary"
                onClick={handleSeek}
                disabled={!seekTs}
                loading={actionLoading}
              >
                Seek
              </Button>
            </div>

            {actionError && (
              <ErrorBanner
                message={actionError}
                onDismiss={() => setActionError(null)}
              />
            )}
          </div>
        </Card>
      )}

      {/* Start New Session Form */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          {session ? "Start New Session" : "Start Replay Session"}
        </h2>
        {session && (
          <p className="text-xs text-yellow-400 mb-3">
            Starting a new session will replace the current one.
          </p>
        )}
        <form onSubmit={handleStart} className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
            <Input
              label="Start Time"
              type="datetime-local"
              value={formStart}
              onChange={(e) => setFormStart(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Timeframe</label>
              <select
                value={formTimeframe}
                onChange={(e) => setFormTimeframe(e.target.value)}
                className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="Speed"
              type="number"
              min="0.1"
              max="100"
              step="0.1"
              placeholder="1"
              value={formSpeed}
              onChange={(e) => setFormSpeed(e.target.value)}
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
            disabled={!formPairId}
          >
            Start Replay
          </Button>
        </form>
      </Card>
    </div>
  );
}
