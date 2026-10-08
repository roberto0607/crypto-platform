import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";

// No SSE message at all (ticks or the server's 5s ping) for this long → the
// connection itself is silent. Two pings can be lost before it trips.
export const CONNECTION_SILENT_MS = 12_000;
// The server's freshest price for the watched pair is older than this →
// prices are genuinely delayed, even though the connection is healthy.
export const PRICE_DELAYED_MS = 15_000;
const CHECK_MS = 1_000;

type StaleInputs = { sseConnected: boolean; lastPriceTickAt: number; priceFreshAt: number | null };

/**
 * True when the price on screen is really delayed: connected, but either
 * nothing has arrived for CONNECTION_SILENT_MS, or the server reports its own
 * price for the subscribed pair is older than PRICE_DELAYED_MS. A quiet
 * symbol is not delayed — its ping reports a fresh (book-based) price age.
 */
export function computePriceStale(s: StaleInputs, now: number): boolean {
  if (!s.sseConnected) return false;
  if (s.lastPriceTickAt > 0 && now - s.lastPriceTickAt > CONNECTION_SILENT_MS) return true;
  return s.priceFreshAt !== null && now - s.priceFreshAt > PRICE_DELAYED_MS;
}

// Derives MarketStatusBadge's display state (priceStale, isHardOffline) from
// the global SSE connection state. Reads sseConnected/sseConnectionState
// straight off appStore rather than calling useSSE() — useSSE() owns the
// actual connection lifecycle (connect/disconnect on mount/unmount) and must
// stay singly-mounted in AppLayout; a second mount (e.g. from TradeToolbar)
// would tear down and reconnect the shared SSE stream every time /trade
// mounts/unmounts. This hook is purely a derived-display reader, safe to
// call from multiple components.
export function useConnectionStatus() {
  const sseConnected = useAppStore((s) => s.sseConnected);
  const sseConnectionState = useAppStore((s) => s.sseConnectionState);

  // Re-evaluated on a steady 1s clock (so a gap is noticed), on every store
  // change (so the first fresh message clears it immediately), and when the
  // tab becomes visible again (timers are throttled in background tabs).
  // The store is read via getState(), never as an effect dependency: making
  // the timestamp a dependency restarted the check on every tick, so under a
  // busy feed it never ran and a stale flag latched on.
  const [priceStale, setPriceStale] = useState(() => computePriceStale(useAppStore.getState(), Date.now()));
  useEffect(() => {
    const check = () => setPriceStale(computePriceStale(useAppStore.getState(), Date.now()));
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    const id = setInterval(check, CHECK_MS);
    const unsubscribe = useAppStore.subscribe(check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // If "reconnecting" persists > 60s, surface OFFLINE + a refresh CTA so the
  // user isn't stuck staring at a spinner.
  const [isHardOffline, setIsHardOffline] = useState(false);
  useEffect(() => {
    if (sseConnectionState !== "reconnecting") {
      setIsHardOffline(false);
      return;
    }
    const id = setTimeout(() => setIsHardOffline(true), 60_000);
    return () => clearTimeout(id);
  }, [sseConnectionState]);

  return { sseConnected, sseConnectionState, priceStale, isHardOffline };
}
