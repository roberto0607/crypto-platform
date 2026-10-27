import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useMarkPriceStore } from "@/stores/markPriceStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useChatStore } from "@/stores/chatStore";
import { connectSSE, disconnectSSE, forceReconnectSSE, type SSEHandlers } from "@/api/sse";
import { recordPing, recordPriceTick } from "@/lib/feedDiagnostics";

const STALE_THRESHOLD_MS = 15_000; // force reconnect if no ping/tick for 15s

export function useSSE() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const sseConnected = useAppStore((s) => s.sseConnected);
  const sseConnectionState = useAppStore((s) => s.sseConnectionState);
  const disconnectRef = useRef<(() => void) | null>(null);

  // ── Main SSE connection ──
  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      disconnectSSE();
      return;
    }

    const handlers: SSEHandlers = {
      onOrderUpdated: (event) => {
        const { orderId, status, filledQty } = event.data;
        useTradingStore.getState().updateOrder(orderId, status, filledQty);
      },

      onTradeCreated: (event) => {
        const d = event.data;
        useTradingStore.getState().addRecentTrade({
          tradeId: d.tradeId,
          pairId: d.pairId,
          side: d.side,
          price: d.price,
          qty: d.qty,
          quoteAmount: d.quoteAmount,
          ts: event.ts,
        });
        // A fill can move the internal (fallback) book; the Kraken book
        // arrives via book.snapshot, so only fetch if those have stopped.
        if (d.pairId === useTradingStore.getState().selectedPairId) {
          useTradingStore.getState().refreshBookIfStale();
        }
        window.dispatchEvent(
          new CustomEvent("sse:trade.created", { detail: d }),
        );
      },

      onWalletUpdated: (event) => {
        useAppStore.getState().applyWalletUpdate(event.data);
      },

      onPriceTick: (event) => {
        recordPriceTick(event);
        const d = event.data;
        if (d.pairId === useTradingStore.getState().selectedPairId) {
          useTradingStore.getState().setSnapshot({
            bid: d.bid,
            ask: d.ask,
            last: d.last,
            ts: String(event.ts),
            source: "live",
          });
        }
        const now = Date.now();
        useAppStore.getState().setLastPriceTickAt(now);
        // Only subscribed pairs' ticks reach this stream, so any tick is
        // fresh price data for the chart being watched.
        useAppStore.getState().setPriceFreshAt(now);
        // Live price lives in pairPricesStore, decoupled from `pairs` so a tick
        // re-renders only that pair's subscribers — not every consumer of `pairs`.
        usePairPricesStore.getState().setPairPrice(d.pairId, parseFloat(d.last));
        window.dispatchEvent(
          new CustomEvent("sse:price.tick", { detail: d }),
        );
      },

      onBookSnapshot: (event) => {
        const { pairId, bids, asks } = event.data;
        useTradingStore.getState().applyBookSnapshot(pairId, { bids, asks });
      },

      onReplayTick: (event) => {
        const d = event.data;
        if (d.pairId === useTradingStore.getState().selectedPairId) {
          useTradingStore.getState().setSnapshot({
            bid: d.bid,
            ask: d.ask,
            last: d.last,
            ts: String(d.sessionTs),
            source: "replay",
          });
        }
        window.dispatchEvent(
          new CustomEvent("sse:replay.tick", { detail: d }),
        );
      },

      onTriggerFired: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:trigger.fired", { detail: event.data }),
        );
      },

      onTriggerCanceled: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:trigger.canceled", { detail: event.data }),
        );
      },

      // The liquidation engine closed one of the user's positions: the toast
      // (ToastProvider), the order panel / position lists (refetch) listen
      // for the window event. Margin came back to USD: reload balances (the
      // wallet.updated it also sends may land first or not at all).
      onPositionLiquidated: (event) => {
        void useAppStore.getState().refreshWallets();
        window.dispatchEvent(
          new CustomEvent("sse:position.liquidated", { detail: event.data }),
        );
      },

      // The liquidation engine's mark (Kraken book mid) for the ISOLATED
      // position card: the same price liquidations are judged by.
      onMarkPrice: (event) => {
        const d = event.data;
        useMarkPriceStore.getState().setMark(d.pairId, d.mark === null ? null : parseFloat(d.mark), d.paused, d.feed);
      },

      // Margin health fell below the warning line: ToastProvider shows it.
      onPositionMarginWarning: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:position.margin_warning", { detail: event.data }),
        );
      },

      onCandleClosed: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:candle.closed", { detail: event.data }),
        );
      },

      onNotificationCreated: (event) => {
        const d = event.data;
        useNotificationStore.getState().addNotification({
          id: d.notificationId,
          kind: d.kind,
          title: d.title,
          body: d.body,
        });
      },

      onSignalNew: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:signal.new", { detail: event.data }),
        );
      },

      // Writes into agentActivityStore (persists across panel close/reopen)
      // rather than the window-CustomEvent pattern used above -- unlike
      // signal.new/match.*, this has no page-local consumer; the panel is a
      // global, always-mounted layout element (see AppLayout.tsx), so it
      // needs state that survives regardless of what's currently rendered.
      onAgentDecision: (event) => {
        useAgentActivityStore.getState().addDecision(event.data, event.ts);
      },

      onMatchStarted: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:match.started", { detail: event.data }),
        );
      },

      onMatchEnded: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:match.ended", { detail: event.data }),
        );
      },

      onMatchPnlUpdate: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:match.pnl.update", { detail: event.data }),
        );
      },

      onMatchSpectatorCount: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:match.spectator_count", { detail: event.data }),
        );
      },

      onChallengeReceived: (event) => {
        window.dispatchEvent(
          new CustomEvent("sse:challenge.received", { detail: event.data }),
        );
      },

      // Friend requests go straight to the global chat store (badge must be
      // correct regardless of what page is open) — same pattern as
      // onNotificationCreated above, not the window-CustomEvent pattern used
      // for match/trade events which are only ever consumed by a page/component
      // that's already mounted.
      onFriendRequestReceived: (event) => {
        useChatStore.getState().onFriendRequestReceived(event.data);
      },

      onFriendRequestAccepted: (event) => {
        useChatStore.getState().onFriendRequestAccepted(event.data);
      },

      // message.received serves two different consumers depending on
      // conversationType: DM messages go straight to the global chatStore
      // (badge must be correct regardless of open page, same as friend
      // requests above). Match Chat messages never touch chatStore — they're
      // ephemeral and component-local — so this ALSO always dispatches the
      // window-CustomEvent pattern every other match/trade event already
      // uses, for a future MatchChatPanel to pick up on its own.
      onMessageReceived: (event) => {
        if (event.data.conversationType === "dm") {
          useChatStore.getState().onMessageReceived(event.data);
        }
        window.dispatchEvent(
          new CustomEvent("sse:message.received", { detail: event.data }),
        );
      },

      // Ping (every 5s) proves the connection is alive even when no price
      // ticks flow, and carries the server's own price age for the
      // subscribed pair — so a quiet symbol with a live book isn't "delayed".
      onPing: ({ ts, priceAgeMs }) => {
        recordPing(ts);
        const now = Date.now();
        useAppStore.getState().setLastPriceTickAt(now);
        useAppStore.getState().setPriceFreshAt(priceAgeMs === null ? null : now - priceAgeMs);
      },

      // On reconnect (any new stream after the first), dispatch so pages can
      // re-fetch missed state. The previous stream's price age no longer
      // applies; the new stream's first ping/tick re-establishes it.
      onReconnected: () => {
        useAppStore.getState().setPriceFreshAt(null);
        // wallet.updated events sent while disconnected are gone — reload balances.
        void useAppStore.getState().refreshWallets();
        window.dispatchEvent(new CustomEvent("sse:reconnected"));
      },
    };

    disconnectRef.current = connectSSE(accessToken, handlers);

    return () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    };
  }, [isAuthenticated, accessToken]);

  // ── Visibility / focus watchdog ──
  // When the tab becomes visible or regains focus, check if SSE is stale
  const checkAndReconnect = useCallback(() => {
    const { lastPriceTickAt } = useAppStore.getState();
    const { isAuthenticated: authed } = useAuthStore.getState();
    if (!authed) return;
    // Allow reconnect attempt even if !connected (in backoff) as long as
    // the staleness threshold is met — shortcuts long backoffs on tab resume.
    if (lastPriceTickAt > 0 && Date.now() - lastPriceTickAt > STALE_THRESHOLD_MS) {
      forceReconnectSSE();
    }
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") checkAndReconnect();
    };
    const handleFocus = () => checkAndReconnect();

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [checkAndReconnect]);

  return { sseConnected, sseConnectionState };
}
