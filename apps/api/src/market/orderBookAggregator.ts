/**
 * orderBookAggregator.ts — Multi-exchange order book imbalance signal.
 *
 * Fetches depth from Coinbase + Kraken every 10s, calculates bid/ask
 * imbalance within 1% of mid price, and combines into a single
 * confidence-weighted signal. Two exchanges agreeing = genuine pressure.
 */

interface ExchangeDepth {
    imbalanceRatio: number;
    totalBidDollars: number;
    totalAskDollars: number;
    signal: string;
}

interface AggregateReading {
    timestamp: number;
    coinbase: ExchangeDepth;
    kraken: ExchangeDepth;
    combined: {
        imbalanceRatio: number;
        signal: string;
        confidence: number;
        agreement: boolean;
    };
}

interface AggregateSnapshot {
    timestamp: number;
    coinbase: ExchangeDepth;
    kraken: ExchangeDepth;
    combined: {
        imbalanceRatio: number;
        signal: string;
        confidence: number;
        agreement: boolean;
    };
    history: {
        timestamp: number;
        combined: { imbalanceRatio: number; signal: string; confidence: number };
    }[];
}

const HISTORY_MAX = 180; // 180 × 10s = 30 min
const POLL_MS = 10_000;
const LOG_INTERVAL_MS = 60_000;

let history: AggregateReading[] = [];
let lastLogTime = 0;
let interval: ReturnType<typeof setInterval> | null = null;

// ── Fetchers ──

interface RawLevel {
    price: number;
    size: number;
}

async function fetchCoinbase(): Promise<{ bids: RawLevel[]; asks: RawLevel[] }> {
    const res = await fetch(
        "https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=BTC-USD&limit=50",
    );
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    const json = (await res.json()) as {
        pricebook: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
    };
    return {
        bids: json.pricebook.bids.map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
        asks: json.pricebook.asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
    };
}

async function fetchKraken(): Promise<{ bids: RawLevel[]; asks: RawLevel[] }> {
    const res = await fetch(
        "https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=50",
    );
    if (!res.ok) throw new Error(`Kraken ${res.status}`);
    const json = (await res.json()) as {
        error: string[];
        result: { XXBTZUSD: { bids: [string, string, number][]; asks: [string, string, number][] } };
    };
    if (json.error.length > 0) throw new Error(`Kraken: ${json.error.join(", ")}`);
    const book = json.result.XXBTZUSD;
    return {
        bids: book.bids.map((b) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
        asks: book.asks.map((a) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
    };
}

// ── Imbalance calculation ──

function calcImbalance(bids: RawLevel[], asks: RawLevel[]): ExchangeDepth {
    if (bids.length === 0 || asks.length === 0) {
        return { imbalanceRatio: 0.5, totalBidDollars: 0, totalAskDollars: 0, signal: "NEUTRAL" };
    }

    const midPrice = (bids[0]!.price + asks[0]!.price) / 2;
    const low = midPrice * 0.99;
    const high = midPrice * 1.01;

    let totalBidDollars = 0;
    for (const b of bids) {
        if (b.price >= low) totalBidDollars += b.price * b.size;
    }

    let totalAskDollars = 0;
    for (const a of asks) {
        if (a.price <= high) totalAskDollars += a.price * a.size;
    }

    const total = totalBidDollars + totalAskDollars;
    const imbalanceRatio = total > 0 ? totalBidDollars / total : 0.5;

    let signal: string;
    if (imbalanceRatio > 0.6) signal = "BULLISH";
    else if (imbalanceRatio < 0.4) signal = "BEARISH";
    else signal = "NEUTRAL";

    return { imbalanceRatio, totalBidDollars, totalAskDollars, signal };
}

function combineSignals(a: ExchangeDepth, b: ExchangeDepth, bothAvailable: boolean): AggregateReading["combined"] {
    const combinedImbalance = bothAvailable
        ? (a.imbalanceRatio + b.imbalanceRatio) / 2
        : a.imbalanceRatio; // single exchange fallback

    const aBullish = a.imbalanceRatio > 0.55;
    const aBearish = a.imbalanceRatio < 0.45;
    const bBullish = b.imbalanceRatio > 0.55;
    const bBearish = b.imbalanceRatio < 0.45;
    const agreement = bothAvailable && ((aBullish && bBullish) || (aBearish && bBearish));

    let confidence: number;
    if (!bothAvailable) {
        confidence = Math.abs(combinedImbalance - 0.5) * 2 * 0.5; // halved for single exchange
    } else if (agreement) {
        confidence = Math.abs(combinedImbalance - 0.5) * 2;
    } else {
        confidence = 0.1;
    }
    confidence = Math.min(confidence, 1);

    let signal: string;
    if (combinedImbalance > 0.6 && agreement) signal = "STRONG_BUY_PRESSURE";
    else if (combinedImbalance > 0.55 && agreement) signal = "MODERATE_BUY_PRESSURE";
    else if (combinedImbalance < 0.4 && agreement) signal = "STRONG_SELL_PRESSURE";
    else if (combinedImbalance < 0.45 && agreement) signal = "MODERATE_SELL_PRESSURE";
    else if (bothAvailable && !agreement && (aBullish !== bBullish || aBearish !== bBearish)) signal = "MIXED";
    else signal = "NEUTRAL";

    return { imbalanceRatio: combinedImbalance, signal, confidence, agreement };
}

// ── Poll ──

const EMPTY_DEPTH: ExchangeDepth = { imbalanceRatio: 0.5, totalBidDollars: 0, totalAskDollars: 0, signal: "NEUTRAL" };

async function poll(): Promise<void> {
    let coinbase: ExchangeDepth | null = null;
    let kraken: ExchangeDepth | null = null;

    const results = await Promise.allSettled([fetchCoinbase(), fetchKraken()]);

    if (results[0]!.status === "fulfilled") {
        coinbase = calcImbalance(results[0]!.value.bids, results[0]!.value.asks);
    } else {
        const reason = (results[0]!.reason as Error)?.message ?? results[0]!.reason;
        console.warn("[OBAggregate] Warning: Coinbase fetch failed, using Kraken only this cycle —", reason);
    }

    if (results[1]!.status === "fulfilled") {
        kraken = calcImbalance(results[1]!.value.bids, results[1]!.value.asks);
    } else {
        const reason = (results[1]!.reason as Error)?.message ?? results[1]!.reason;
        console.warn("[OBAggregate] Warning: Kraken fetch failed, using Coinbase only this cycle —", reason);
    }

    if (!coinbase && !kraken) {
        console.warn("[OBAggregate] Warning: all exchanges failed, using cached data");
        return;
    }

    const cb = coinbase ?? EMPTY_DEPTH;
    const kr = kraken ?? EMPTY_DEPTH;
    const bothAvailable = coinbase !== null && kraken !== null;
    const primary = coinbase ?? kraken!;
    const combined = combineSignals(
        bothAvailable ? cb : primary,
        bothAvailable ? kr : primary,
        bothAvailable,
    );

    const reading: AggregateReading = {
        timestamp: Date.now(),
        coinbase: cb,
        kraken: kr,
        combined,
    };

    history.push(reading);
    if (history.length > HISTORY_MAX) {
        history = history.slice(-HISTORY_MAX);
    }

    if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
        console.log(
            `[OBAggregate] Coinbase: ${(cb.imbalanceRatio * 100).toFixed(1)}% bid / ` +
            `Kraken: ${(kr.imbalanceRatio * 100).toFixed(1)}% bid / ` +
            `Signal: ${combined.signal} / Confidence: ${combined.confidence.toFixed(2)} / ` +
            `Agreement: ${combined.agreement}`,
        );
        lastLogTime = Date.now();
    }
}

// ── Public API ──

export function getCurrentOrderBookSignal(): AggregateSnapshot | null {
    if (history.length === 0) return null;

    const latest = history[history.length - 1]!;

    return {
        timestamp: latest.timestamp,
        coinbase: latest.coinbase,
        kraken: latest.kraken,
        combined: latest.combined,
        history: history.map((r) => ({
            timestamp: r.timestamp,
            combined: {
                imbalanceRatio: r.combined.imbalanceRatio,
                signal: r.combined.signal,
                confidence: r.combined.confidence,
            },
        })),
    };
}

export function initOrderBookAggregator(): void {
    if (interval) return;
    console.log("[OBAggregate] Service initialized, polling every 10s");
    poll();
    interval = setInterval(poll, POLL_MS);
}

export function stopOrderBookAggregator(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
