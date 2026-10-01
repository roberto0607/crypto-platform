/**
 * useLandingStream — the public landing SSE: live BTC/ETH/SOL prices, the
 * featured match (or null), and this visitor's own quick-call results.
 *
 * `featured` is `undefined` until the first frame arrives, so the page can
 * tell "not known yet" from "no live match".
 */

import { useEffect, useRef, useState } from "react";
import { fetchEventSource, EventStreamContentType } from "@microsoft/fetch-event-source";
import type { FeaturedMatch, SettledQuickCall } from "@/api/endpoints/landing";

const STREAM_URL = `${import.meta.env.VITE_API_BASE ?? "/api"}/v1/public/landing-stream`;
const BACKOFF_STEPS = [1_000, 2_000, 4_000, 8_000, 30_000];
/** Frames only arrive on change, so silence this long means the feed is down: hide the price. */
export const PRICE_EXPIRY_MS = 60_000;
const EXPIRY_CHECK_MS = 5_000;

export type LandingSymbol = "BTC" | "ETH" | "SOL";

export interface PriceTick {
  price: string;
  /** Direction of the last change, null on the first tick. */
  move: "up" | "down" | null;
  /** Local receipt time, for expiry. */
  at: number;
}

export interface LandingStreamState {
  prices: Partial<Record<LandingSymbol, PriceTick>>;
  featured: FeaturedMatch | null | undefined;
  lastResult: (SettledQuickCall & { streak: number }) | null;
}

class RetriableError extends Error {}

/** @param enabled open the stream only once the anon session cookie exists. */
export function useLandingStream(enabled: boolean): LandingStreamState {
  const [prices, setPrices] = useState<LandingStreamState["prices"]>({});
  const [featured, setFeatured] = useState<FeaturedMatch | null | undefined>(undefined);
  const [lastResult, setLastResult] = useState<LandingStreamState["lastResult"]>(null);
  const attempt = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();

    void fetchEventSource(STREAM_URL, {
      signal: ctrl.signal,
      credentials: "include",
      openWhenHidden: false,
      async onopen(res) {
        if (res.ok && res.headers.get("content-type")?.includes(EventStreamContentType)) {
          attempt.current = 0;
          return;
        }
        throw new RetriableError(`landing stream ${res.status}`);
      },
      onmessage(msg) {
        if (!msg.data) return;
        const data = JSON.parse(msg.data);
        if (msg.event === "price") {
          const { symbol, price } = data as { symbol: LandingSymbol; price: string };
          setPrices((prev) => {
            const before = prev[symbol]?.price;
            const move = before === undefined ? null : Number(price) >= Number(before) ? "up" : "down";
            return { ...prev, [symbol]: { price, move, at: Date.now() } };
          });
        } else if (msg.event === "featured") {
          setFeatured(data as FeaturedMatch | null);
        } else if (msg.event === "quickcall") {
          setLastResult(data as LandingStreamState["lastResult"]);
        }
      },
      onerror() {
        const delay = BACKOFF_STEPS[Math.min(attempt.current, BACKOFF_STEPS.length - 1)]!;
        attempt.current += 1;
        return delay;
      },
    });

    const expiry = setInterval(() => {
      const cutoff = Date.now() - PRICE_EXPIRY_MS;
      setPrices((prev) => {
        const stale = (Object.keys(prev) as LandingSymbol[]).filter((s) => prev[s]!.at < cutoff);
        if (stale.length === 0) return prev;
        const next = { ...prev };
        for (const s of stale) delete next[s];
        return next;
      });
    }, EXPIRY_CHECK_MS);

    return () => {
      ctrl.abort();
      clearInterval(expiry);
    };
  }, [enabled]);

  return { prices, featured, lastResult };
}
