import { fetchEventSource, EventStreamContentType } from "@microsoft/fetch-event-source";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import type { SSEEvent } from "@/types/api";

const SSE_URL = `${import.meta.env.VITE_API_BASE ?? "/api"}/v1/events`;

// Exponential backoff: 1s → 2s → 4s → 8s → 30s cap
const BACKOFF_STEPS = [1_000, 2_000, 4_000, 8_000, 30_000];

// If no message (including pings) received for this long, treat connection as dead
const HEARTBEAT_TIMEOUT_MS = 30_000;

export type SseConnectionState = "connected" | "disconnected" | "reconnecting";

export interface SSEHandlers {
  onOrderUpdated?: (event: Extract<SSEEvent, { type: "order.updated" }>) => void;
  onTradeCreated?: (event: Extract<SSEEvent, { type: "trade.created" }>) => void;
  onWalletUpdated?: (event: Extract<SSEEvent, { type: "wallet.updated" }>) => void;
  onPriceTick?: (event: Extract<SSEEvent, { type: "price.tick" }>) => void;
  onReplayTick?: (event: Extract<SSEEvent, { type: "replay.tick" }>) => void;
  onTriggerFired?: (event: Extract<SSEEvent, { type: "trigger.fired" }>) => void;
  onTriggerCanceled?: (event: Extract<SSEEvent, { type: "trigger.canceled" }>) => void;
  onCandleClosed?: (event: Extract<SSEEvent, { type: "candle.closed" }>) => void;
  onNotificationCreated?: (event: Extract<SSEEvent, { type: "notification.created" }>) => void;
  onSignalNew?: (event: Extract<SSEEvent, { type: "signal.new" }>) => void;
  onMatchStarted?: (event: Extract<SSEEvent, { type: "match.started" }>) => void;
  onChallengeReceived?: (event: Extract<SSEEvent, { type: "challenge.received" }>) => void;
  onPing?: (ts: number) => void;
  onReconnected?: () => void;
}

let abortController: AbortController | null = null;
let reconnectAttempt = 0;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let wasConnected = false;
// Stashed so forceReconnectSSE can re-invoke connectSSE with a fresh
// AbortController. The library terminates its retry loop permanently
// when the outer signal is aborted, so we must start a new loop instead
// of trying to resurrect the old one.
let lastToken: string | null = null;
let lastHandlers: SSEHandlers | null = null;

function setSseState(state: SseConnectionState): void {
  useAppStore.getState().setSseConnectionState(state);
  useAppStore.getState().setSseConnected(state === "connected");
}

function resetHeartbeatTimer(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    // No message received — connection is dead, force reconnect
    if (abortController && !abortController.signal.aborted) {
      console.warn("[sse] heartbeat timeout — forcing reconnect");
      setSseState("reconnecting");
      forceReconnectSSE();
    }
  }, HEARTBEAT_TIMEOUT_MS);
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function connectSSE(token: string, handlers: SSEHandlers): () => void {
  // Disconnect any existing connection first
  disconnectSSE();

  abortController = new AbortController();
  wasConnected = false;
  lastToken = token;
  lastHandlers = handlers;

  fetchEventSource(SSE_URL, {
    signal: abortController.signal,
    headers: {
      Authorization: `Bearer ${token}`,
    },

    async onopen(response) {
      if (response.ok && response.headers.get("content-type")?.includes(EventStreamContentType)) {
        const isReconnect = wasConnected;
        reconnectAttempt = 0;
        wasConnected = true;
        setSseState("connected");
        resetHeartbeatTimer();

        // On reconnect, notify so callers can re-fetch missed state
        if (isReconnect) {
          handlers.onReconnected?.();
          window.dispatchEvent(new CustomEvent("sse:reconnected"));
        }
        return;
      }
      // Attach status so onerror can branch on HTTP code.
      const err = new Error(`SSE open failed: ${response.status}`) as Error & { status?: number };
      err.status = response.status;
      throw err;
    },

    onmessage(msg) {
      // Any message (including ping) resets the heartbeat timer
      resetHeartbeatTimer();

      if (!msg.event || !msg.data) return;

      // Handle ping (not in SSEEvent union — raw from backend)
      if (msg.event === "ping") {
        try {
          const data = JSON.parse(msg.data) as { ts: number };
          handlers.onPing?.(data.ts);
        } catch { /* ignore */ }
        return;
      }

      let event: SSEEvent;
      try {
        event = JSON.parse(msg.data) as SSEEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case "order.updated":
          handlers.onOrderUpdated?.(event);
          break;
        case "trade.created":
          handlers.onTradeCreated?.(event);
          break;
        case "wallet.updated":
          handlers.onWalletUpdated?.(event);
          break;
        case "price.tick":
          handlers.onPriceTick?.(event);
          break;
        case "replay.tick":
          handlers.onReplayTick?.(event);
          break;
        case "trigger.fired":
          handlers.onTriggerFired?.(event);
          break;
        case "trigger.canceled":
          handlers.onTriggerCanceled?.(event);
          break;
        case "candle.closed":
          handlers.onCandleClosed?.(event);
          break;
        case "notification.created":
          handlers.onNotificationCreated?.(event);
          break;
        case "signal.new":
          handlers.onSignalNew?.(event);
          break;
        case "match.started":
          handlers.onMatchStarted?.(event);
          break;
        case "challenge.received":
          handlers.onChallengeReceived?.(event);
          break;
      }
    },

    onclose() {
      clearHeartbeatTimer();
      setSseState("disconnected");
    },

    onerror(err) {
      clearHeartbeatTimer();
      const status = (err as Error & { status?: number }).status;
      console.error("[sse] onerror:", { message: (err as Error)?.message, status, reconnectAttempt });

      // If aborted intentionally, don't reconnect
      if (abortController?.signal.aborted) {
        setSseState("disconnected");
        throw err;
      }

      // If token is gone (logged out), don't reconnect
      if (!useAuthStore.getState().isAuthenticated) {
        setSseState("disconnected");
        throw err;
      }

      // 401 = auth expired. Stop retrying, emit event so UI can redirect.
      if (status === 401) {
        console.warn("[sse] 401 unauthorized — stopping retries");
        window.dispatchEvent(new CustomEvent("sse:unauthorized"));
        setSseState("disconnected");
        throw err;
      }

      // Show reconnecting state (502/503/network errors keep retrying)
      setSseState("reconnecting");

      // Exponential backoff: 1s → 2s → 4s → 8s → 30s (never give up)
      const delay = BACKOFF_STEPS[Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1)]!;
      reconnectAttempt++;
      return delay;
    },

    openWhenHidden: true,
  });

  return () => disconnectSSE();
}

/** Force a reconnect — tears down and re-establishes the SSE connection.
 *
 * IMPORTANT: aborting the outer signal terminates fetch-event-source's
 * retry loop permanently (it resolves its outer promise on abort). So we
 * must spin up a fresh connectSSE() invocation with a new AbortController
 * instead of relying on the library's internal retry. */
export function forceReconnectSSE(): void {
  const token = useAuthStore.getState().accessToken ?? lastToken;
  const handlers = lastHandlers;
  if (!token || !handlers) {
    console.warn("[sse] forceReconnectSSE skipped — no token or handlers");
    return;
  }

  clearHeartbeatTimer();
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  setSseState("reconnecting");
  // Re-enter connectSSE: fresh AbortController, fresh fetchEventSource loop.
  connectSSE(token, handlers);
}

export function disconnectSSE(): void {
  clearHeartbeatTimer();
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  reconnectAttempt = 0;
  wasConnected = false;
  lastToken = null;
  lastHandlers = null;
  setSseState("disconnected");
}
