import { useEffect, useRef, useState } from "react";
import { getMarketQuote, type MarketQuote, type QuoteParams } from "@/api/endpoints/quote";

export const QUOTE_DEBOUNCE_MS = 250;

export type QuotesState = {
  /** One per request, in order; null = that request failed. Null until the first answer. */
  quotes: (MarketQuote | null)[] | null;
  /** A newer key is waiting for its answer: `quotes` is the last one. */
  loading: boolean;
};

const IDLE: QuotesState = { quotes: null, loading: false };
const scopeOf = (key: string | null) => key?.split(":")[0];

/**
 * Debounced quotes for `key` (`<pairId>:…`; null = nothing to quote). `build`
 * runs when the request fires, not per render, so a qty that moves with every
 * tick is read fresh without a new key restarting the debounce. A newer key
 * aborts the request in flight. `refreshMs` re-quotes in the background, while
 * the tab is visible: a preview left open follows the book without dimming.
 * Quotes for another pair are dropped at once, never shown dimmed.
 */
export function useMarketQuotes(key: string | null, build: () => QuoteParams[], refreshMs?: number): QuotesState {
  const buildRef = useRef(build);
  buildRef.current = build;
  const [state, setState] = useState<QuotesState & { key: string | null }>({ ...IDLE, key: null });

  useEffect(() => {
    if (key === null) {
      setState({ ...IDLE, key: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    let ctrl = new AbortController();
    const run = async () => {
      ctrl.abort();
      const mine = (ctrl = new AbortController());
      const answers = await Promise.all(buildRef.current().map((params) =>
        getMarketQuote(params, mine.signal)
          .then((res) => (res.data?.touchPrice !== undefined ? res.data : null))
          .catch(() => null)));
      if (!mine.signal.aborted) setState({ key, quotes: answers, loading: false });
    };
    const debounce = setTimeout(() => void run(), QUOTE_DEBOUNCE_MS);
    const refresh = refreshMs ? setInterval(() => { if (!document.hidden) void run(); }, refreshMs) : undefined;
    return () => {
      clearTimeout(debounce);
      clearInterval(refresh);
      ctrl.abort();
    };
  }, [key, refreshMs]);

  if (key === null || scopeOf(state.key) !== scopeOf(key)) return { quotes: null, loading: key !== null };
  return { quotes: state.quotes, loading: state.loading };
}
