import { fetchEventSource, EventStreamContentType } from "@microsoft/fetch-event-source";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import type { SSEEvent } from "@/types/api";

const SSE_URL = `${import.meta.env.VITE_API_BASE ?? "/api"}/v1/events`;
const RECONNECT_DELAY_MS = 3_000;

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
}

let abortController: AbortController | null = null;

export function connectSSE(token: string, handlers: SSEHandlers): () => void {
  // Disconnect any existing connection first
  disconnectSSE();

  abortController = new AbortController();

  fetchEventSource(SSE_URL, {
    signal: abortController.signal,
    headers: {
      Authorization: `Bearer ${token}`,
    },

    async onopen(response) {
      if (response.ok && response.headers.get("content-type")?.includes(EventStreamContentType)) {
        useAppStore.getState().setSseConnected(true);
        return;
      }
      throw new Error(`SSE open failed: ${response.status}`);
    },

    onmessage(msg) {
      if (!msg.event || !msg.data) return;

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
      }
    },

    onclose() {
      useAppStore.getState().setSseConnected(false);
    },

    onerror(err) {
      useAppStore.getState().setSseConnected(false);

      // If aborted intentionally, don't reconnect
      if (abortController?.signal.aborted) {
        throw err;
      }

      // If token is gone (logged out), don't reconnect
      if (!useAuthStore.getState().isAuthenticated) {
        throw err;
      }

      // Return reconnect delay — fetchEventSource will retry automatically
      return RECONNECT_DELAY_MS;
    },

    openWhenHidden: true,
  });

  return () => disconnectSSE();
}

export function disconnectSSE(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  useAppStore.getState().setSseConnected(false);
}
