import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";

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
  const lastPriceTickAt = useAppStore((s) => s.lastPriceTickAt);

  const [priceStale, setPriceStale] = useState(false);
  useEffect(() => {
    if (!sseConnected) { setPriceStale(false); return; }
    const id = setInterval(() => {
      const stale = lastPriceTickAt > 0 && Date.now() - lastPriceTickAt > 10_000;
      setPriceStale(stale);
    }, 3_000);
    return () => clearInterval(id);
  }, [sseConnected, lastPriceTickAt]);

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
