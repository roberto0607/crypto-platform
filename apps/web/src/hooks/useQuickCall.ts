/**
 * useQuickCall — the visitor's 60-second BTC call: load state (which also
 * issues the anon session cookie the landing stream needs), place a call,
 * and apply the settled result from the stream — or from a GET fallback if
 * the stream's push doesn't arrive shortly after the deadline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AxiosError } from "axios";
import {
  getQuickCallCurrent,
  placeQuickCall,
  type CallDirection,
  type OpenQuickCall,
  type SettledQuickCall,
} from "@/api/endpoints/landing";

/** How long a result stays on screen before a pending panel switch happens. */
export const RESULT_HOLD_MS = 4_000;
const FALLBACK_POLL_DELAY_MS = 3_000;

export interface OpenRound {
  call: OpenQuickCall;
  /** Local-clock deadline (avoids trusting client/server clock agreement). */
  deadline: number;
}

export interface QuickCallHook {
  sessionReady: boolean;
  round: OpenRound | null;
  streak: number;
  history: SettledQuickCall[];
  lastSettled: SettledQuickCall | null;
  roundInProgress: boolean;
  error: string | null;
  placing: boolean;
  place(direction: CallDirection): Promise<void>;
  /** Apply a result pushed over the landing stream. */
  applyStreamResult(result: SettledQuickCall & { streak: number }): void;
}

const ERRORS: Record<string, string> = {
  call_already_open: "You already have a call running.",
  rate_limited: "That's the hourly limit — try again later.",
  price_feed_stale: "Price feed is catching up — try again in a few seconds.",
};

export function useQuickCall(): QuickCallHook {
  const [sessionReady, setSessionReady] = useState(false);
  const [round, setRound] = useState<OpenRound | null>(null);
  const [streak, setStreak] = useState(0);
  const [history, setHistory] = useState<SettledQuickCall[]>([]);
  const [lastSettled, setLastSettled] = useState<SettledQuickCall | null>(null);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const roundRef = useRef<OpenRound | null>(null);
  roundRef.current = round;

  const applySettled = useCallback((settled: SettledQuickCall, newStreak: number) => {
    setRound((r) => (r && r.call.id === settled.id ? null : r));
    setStreak(newStreak);
    setHistory((h) => (h.some((x) => x.id === settled.id) ? h : [settled, ...h].slice(0, 20)));
    setLastSettled(settled);
    setHolding(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const { data } = await getQuickCallCurrent();
      setStreak(data.streak);
      setHistory(data.history);
      // Resuming a call after reload: no local entry time to anchor to, so the
      // server's settleAt is the best available deadline.
      setRound(data.call ? { call: data.call, deadline: Math.max(Date.now(), data.call.settleAt) } : null);
      if (roundRef.current && !data.call) {
        const settled = data.history.find((h) => h.id === roundRef.current!.call.id);
        if (settled) applySettled(settled, data.streak);
      }
    } catch {
      // Page still works without history; calls will surface their own errors.
    } finally {
      setSessionReady(true);
    }
  }, [applySettled]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fallback: if no push arrived shortly after the deadline, ask the server.
  useEffect(() => {
    if (!round) return;
    const wait = Math.max(0, round.deadline - Date.now()) + FALLBACK_POLL_DELAY_MS;
    const t = setTimeout(() => void load(), wait);
    return () => clearTimeout(t);
  }, [round, load]);

  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setHolding(false), RESULT_HOLD_MS);
    return () => clearTimeout(t);
  }, [holding, lastSettled]);

  const place = useCallback(async (direction: CallDirection) => {
    setError(null);
    setPlacing(true);
    try {
      const { data } = await placeQuickCall(direction);
      setRound({ call: data.call, deadline: Date.now() + (data.call.settleAt - data.call.entryAt) });
      setStreak(data.streak);
      setLastSettled(null);
      setHolding(false);
    } catch (err) {
      const code = (err as AxiosError<{ error?: string }>).response?.data?.error;
      setError((code && ERRORS[code]) ?? "Couldn't place that call — try again.");
    } finally {
      setPlacing(false);
    }
  }, []);

  const applyStreamResult = useCallback(
    (r: SettledQuickCall & { streak: number }) => applySettled(r, r.streak),
    [applySettled],
  );

  return {
    sessionReady,
    round,
    streak,
    history,
    lastSettled,
    roundInProgress: round !== null || holding,
    error,
    placing,
    place,
    applyStreamResult,
  };
}
