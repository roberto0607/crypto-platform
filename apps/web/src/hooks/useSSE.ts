import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { connectSSE, disconnectSSE, type SSEHandlers } from "@/api/sse";

export function useSSE() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const sseConnected = useAppStore((s) => s.sseConnected);
  const disconnectRef = useRef<(() => void) | null>(null);

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
        // Refresh order book on new trade for the selected pair
        if (d.pairId === useTradingStore.getState().selectedPairId) {
          useTradingStore.getState().refreshBook();
        }
        window.dispatchEvent(
          new CustomEvent("sse:trade.created", { detail: d }),
        );
      },

      onWalletUpdated: (event) => {
        const wallets = useAppStore.getState().wallets;
        const updated = wallets.map((w) =>
          w.id === event.data.walletId
            ? { ...w, balance: event.data.balance, reserved: event.data.reserved }
            : w,
        );
        useAppStore.getState().setWallets(updated);
      },

      onPriceTick: (event) => {
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
        // Update last_price on the pair in appStore
        const pairs = useAppStore.getState().pairs;
        const updatedPairs = pairs.map((p) =>
          p.id === d.pairId ? { ...p, last_price: d.last } : p,
        );
        useAppStore.getState().setPairs(updatedPairs);
        window.dispatchEvent(
          new CustomEvent("sse:price.tick", { detail: d }),
        );
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
    };

    disconnectRef.current = connectSSE(accessToken, handlers);

    return () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    };
  }, [isAuthenticated, accessToken]);

  return { sseConnected };
}
