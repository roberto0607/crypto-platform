/**
 * datafeedAdapter.ts — chart data-fetching/subscription logic, extracted
 * from CandlestickChart.tsx so it's a standalone, swap-compatible module.
 *
 * Deliberately targets an internal shape (plain pairId/timeframe strings,
 * Candle[] arrays) rather than TradingView Charting Library's
 * IDatafeedChartApi types — Charting Library access isn't confirmed
 * approved, so this is built against lightweight-charts' existing surface
 * (what CandlestickChart.tsx already consumes) with a thin type-mapping
 * shim to be written later if/when Charting Library is adopted. See
 * docs/designs/2026-07-22-multi-asset-datafeed-gate1.md section 4.1.
 */
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { searchPairs } from "@/api/endpoints/trading";
import { subscribeStream } from "@/api/endpoints/events";
import { waitForStreamId, onStreamReady } from "@/api/sse";
import type { TradingPair } from "@/types/api";

export type { Candle, Timeframe };

export interface PriceTick {
  pairId: string;
  symbol: string;
  bid: string | null;
  ask: string | null;
  last: string;
}

export interface CandleClosedTick {
  pairId: string;
  timeframe: string;
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface BarSubscriptionHandle {
  pairId: string;
  _cleanup: () => void;
}

// ── Stream interest set ──
// The server keeps each SSE stream's price.tick interest set in memory and
// starts every new stream (each reconnect gets a new streamId) EMPTY. So the
// desired set is re-sent on every stream.ready, not just on chart
// mount/pair switch — otherwise a reconnect silently stops all live ticks
// until the user switches pairs.
//
// Sends are serialized and latest-wins (module-wide: only one chart is open
// at a time), so a pair switch's unsubscribe([]) can never land after the
// new pair's subscribe([B]) and blank the stream.
let interestChain: Promise<void> = Promise.resolve();
let interestSeq = 0;

function sendInterestSet(pairIds: string[]): void {
  const seq = ++interestSeq;
  interestChain = interestChain
    .then(async () => {
      if (seq !== interestSeq) return; // superseded before it was sent
      const streamId = await waitForStreamId();
      if (seq !== interestSeq) return;
      await subscribeStream(streamId, pairIds);
    })
    .catch(() => {
      // Best-effort: a failed send (e.g. the stream died mid-request) is
      // retried by the next stream.ready.
    });
}

/** TEST-ONLY — wait for queued interest-set sends to settle. */
export function __interestSetSettled(): Promise<void> {
  return interestChain;
}

export function createDatafeedAdapter() {
  // Shared across every getBars() call from this adapter instance (initial
  // load + scroll-back pagination) so a stale response for a previously
  // selected pair can never land after a newer call has started and clobber
  // the chart — the pre-existing race this extraction fixes (fetchCandles
  // had no cancellation guard).
  let requestToken = 0;

  async function getBars(
    pairId: string,
    timeframe: Timeframe,
    opts?: { before?: string; limit?: number },
  ): Promise<Candle[] | null> {
    const token = ++requestToken;
    const res = await getCandles(pairId, { timeframe, ...opts });
    if (token !== requestToken) return null; // superseded by a newer call
    return res.data.candles;
  }

  /**
   * Registers window listeners for this pair's price.tick/candle.closed SSE
   * events (dispatched globally by useSSE.ts off the shared SSE connection)
   * and tells the server which pairId this connection's stream should
   * receive full-fidelity ticks for (POST /v1/events/subscribe — see
   * api/sse.ts's waitForStreamId, which resolves once the stream.ready
   * frame has arrived even if that hasn't happened yet). Only one chart is
   * ever open at a time in this app, so this always REPLACES the interest
   * set with exactly [pairId], not additive.
   */
  function subscribeBars(
    pairId: string,
    timeframe: string,
    onTick: (tick: PriceTick) => void,
    onCandleClosed: (candle: CandleClosedTick) => void,
  ): BarSubscriptionHandle {
    const handlePriceTick = (e: Event) => {
      const detail = (e as CustomEvent<PriceTick>).detail;
      if (detail.pairId !== pairId) return;
      onTick(detail);
    };
    const handleCandleClosed = (e: Event) => {
      const detail = (e as CustomEvent<CandleClosedTick>).detail;
      if (detail.pairId !== pairId || detail.timeframe !== timeframe) return;
      onCandleClosed(detail);
    };

    window.addEventListener("sse:price.tick", handlePriceTick);
    window.addEventListener("sse:candle.closed", handleCandleClosed);

    sendInterestSet([pairId]);
    // Every later stream (reconnect, token refresh) starts empty — re-send.
    const stopResubscribing = onStreamReady(() => sendInterestSet([pairId]));

    return {
      pairId,
      _cleanup: () => {
        window.removeEventListener("sse:price.tick", handlePriceTick);
        window.removeEventListener("sse:candle.closed", handleCandleClosed);
        stopResubscribing();
      },
    };
  }

  function unsubscribeBars(handle: BarSubscriptionHandle): void {
    handle._cleanup();
    sendInterestSet([]);
  }

  async function searchSymbols(query: string): Promise<TradingPair[]> {
    const res = await searchPairs(query);
    return res.data.pairs;
  }

  return { getBars, subscribeBars, unsubscribeBars, searchSymbols };
}

export type DatafeedAdapter = ReturnType<typeof createDatafeedAdapter>;
