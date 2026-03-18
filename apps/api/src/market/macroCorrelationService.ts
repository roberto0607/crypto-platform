/**
 * macroCorrelationService.ts — Macro correlation tracking (DXY + QQQ vs BTC).
 *
 * Polls Yahoo Finance every 5 minutes for DXY (dollar index), QQQ (Nasdaq proxy),
 * and BTC-USD. Calculates Pearson correlation over a 60-candle window to determine
 * how BTC is moving relative to macro factors.
 *
 * Regime detection:
 *   - MACRO_DRIVEN: BTC positively correlated with QQQ, negatively with DXY
 *   - DOLLAR_DRIVEN: BTC strongly negatively correlated with DXY
 *   - RISK_ASSET: BTC strongly positively correlated with QQQ
 *   - DECORRELATED: No significant correlation with either
 *   - MIXED: Unusual correlation pattern
 */

// ── Types ──

interface MacroPrice {
    timestamp: number;
    close: number;
    returnPct: number | null; // % change from previous candle
}

interface CorrelationResult {
    pearson: number;
    sampleSize: number;
}

interface MacroReading {
    timestamp: number;
    dxy: { price: number; change1h: number };
    qqq: { price: number; change1h: number };
    btc: { price: number; change1h: number };
    correlations: {
        btcDxy: CorrelationResult;
        btcQqq: CorrelationResult;
    };
    regime: string;
    dxyTrend: string;
    marketOpen: boolean;
}

interface MacroSnapshot {
    timestamp: number;
    dxy: { price: number; change1h: number };
    qqq: { price: number; change1h: number };
    btc: { price: number; change1h: number };
    correlations: {
        btcDxy: CorrelationResult;
        btcQqq: CorrelationResult;
    };
    regime: string;
    regimeDescription: string;
    dxyTrend: string;
    dxyImpact: string;
    marketOpen: boolean;
    history: {
        timestamp: number;
        regime: string;
        btcDxy: number;
        btcQqq: number;
    }[];
}

// ── Constants ──

const POLL_MS = 5 * 60_000; // 5 minutes
const CORRELATION_WINDOW = 60; // 60 candles for Pearson calculation
const HISTORY_MAX = 288; // 288 × 5min = 24h
const LOG_INTERVAL_MS = 5 * 60_000;

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0" };

// ── State ──

let history: MacroReading[] = [];
let dxyCandles: MacroPrice[] = [];
let qqqCandles: MacroPrice[] = [];
let btcCandles: MacroPrice[] = [];
let lastLogTime = 0;
let interval: ReturnType<typeof setInterval> | null = null;

// ── Yahoo Finance fetcher ──

async function fetchYahooCandles(symbol: string): Promise<MacroPrice[]> {
    const url = `${YAHOO_BASE}/${symbol}?interval=1m&range=2h`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);

    const json = (await res.json()) as {
        chart: {
            result: {
                timestamp: number[];
                indicators: {
                    quote: { close: (number | null)[] }[];
                };
            }[];
            error: { description: string } | null;
        };
    };

    if (json.chart.error) throw new Error(`Yahoo ${symbol}: ${json.chart.error.description}`);

    const result = json.chart.result[0];
    if (!result || !result.timestamp) return [];

    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0]?.close ?? [];

    const candles: MacroPrice[] = [];
    let prevClose: number | null = null;

    for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (close == null || isNaN(close)) continue;

        const returnPct = prevClose != null ? ((close - prevClose) / prevClose) * 100 : null;
        candles.push({ timestamp: timestamps[i]! * 1000, close, returnPct });
        prevClose = close;
    }

    return candles;
}

// ── Pearson correlation ──

function pearsonCorrelation(xs: number[], ys: number[]): CorrelationResult {
    const n = Math.min(xs.length, ys.length);
    if (n < 10) return { pearson: 0, sampleSize: n };

    const xSlice = xs.slice(-n);
    const ySlice = ys.slice(-n);

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += xSlice[i]!;
        sumY += ySlice[i]!;
        sumXY += xSlice[i]! * ySlice[i]!;
        sumX2 += xSlice[i]! * xSlice[i]!;
        sumY2 += ySlice[i]! * ySlice[i]!;
    }

    const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (denom === 0) return { pearson: 0, sampleSize: n };

    const r = (n * sumXY - sumX * sumY) / denom;
    return { pearson: Math.round(r * 1000) / 1000, sampleSize: n };
}

// ── Market hours check (NYSE: 9:30 AM – 4:00 PM ET, Mon–Fri) ──

function isMarketOpen(): boolean {
    const now = new Date();
    // Convert to ET
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false; // weekend

    const hours = et.getHours();
    const minutes = et.getMinutes();
    const timeMinutes = hours * 60 + minutes;

    return timeMinutes >= 570 && timeMinutes < 960; // 9:30=570, 16:00=960
}

// ── Regime detection ──

function detectRegime(btcDxy: number, btcQqq: number): string {
    const dxyStrong = Math.abs(btcDxy) > 0.5;
    const qqqStrong = Math.abs(btcQqq) > 0.5;

    // Classic macro: BTC tracks stocks, inverse to dollar
    if (btcQqq > 0.4 && btcDxy < -0.3) return "MACRO_DRIVEN";

    // Dollar dominant
    if (dxyStrong && btcDxy < -0.5) return "DOLLAR_DRIVEN";

    // Risk asset behavior
    if (qqqStrong && btcQqq > 0.5) return "RISK_ASSET";

    // No correlation
    if (!dxyStrong && !qqqStrong) return "DECORRELATED";

    return "MIXED";
}

function regimeDescription(regime: string): string {
    switch (regime) {
        case "MACRO_DRIVEN": return "BTC tracking equities and inversely correlated with USD — macro risk-on/off driving crypto";
        case "DOLLAR_DRIVEN": return "Dollar strength/weakness is the primary BTC driver — watch DXY closely";
        case "RISK_ASSET": return "BTC behaving as a risk asset, strongly correlated with Nasdaq";
        case "DECORRELATED": return "BTC moving independently of traditional macro factors — crypto-native drivers dominating";
        case "MIXED": return "Unusual correlation pattern — multiple forces acting on BTC simultaneously";
        default: return "Unknown regime";
    }
}

// ── DXY trend + impact ──

function getDxyTrend(candles: MacroPrice[]): string {
    if (candles.length < 10) return "INSUFFICIENT_DATA";

    const recent = candles.slice(-10);
    const first = recent[0]!.close;
    const last = recent[recent.length - 1]!.close;
    const changePct = ((last - first) / first) * 100;

    if (changePct > 0.05) return "STRENGTHENING";
    if (changePct < -0.05) return "WEAKENING";
    return "STABLE";
}

function getDxyImpact(dxyTrend: string, btcDxyCorr: number): string {
    if (Math.abs(btcDxyCorr) < 0.3) return "LOW_IMPACT";

    if (dxyTrend === "STRENGTHENING" && btcDxyCorr < -0.3) return "HEADWIND";
    if (dxyTrend === "WEAKENING" && btcDxyCorr < -0.3) return "TAILWIND";
    if (dxyTrend === "STRENGTHENING" && btcDxyCorr > 0.3) return "TAILWIND";
    if (dxyTrend === "WEAKENING" && btcDxyCorr > 0.3) return "HEADWIND";

    return "NEUTRAL";
}

// ── 1h change calculation ──

function calc1hChange(candles: MacroPrice[]): number {
    if (candles.length < 2) return 0;
    const now = candles[candles.length - 1]!.close;
    // ~60 candles back = 1h of 1m candles
    const idx = Math.max(0, candles.length - 60);
    const then = candles[idx]!.close;
    return then > 0 ? ((now - then) / then) * 100 : 0;
}

// ── Poll ──

async function poll(): Promise<void> {
    const marketOpen = isMarketOpen();

    try {
        const [dxyResult, qqqResult, btcResult] = await Promise.allSettled([
            fetchYahooCandles("DX-Y.NYB"),
            fetchYahooCandles("QQQ"),
            fetchYahooCandles("BTC-USD"),
        ]);

        if (dxyResult.status === "fulfilled" && dxyResult.value.length > 0) {
            dxyCandles = dxyResult.value;
        } else if (dxyResult.status === "rejected") {
            console.warn("[MacroCorr] DXY fetch failed:", dxyResult.reason);
        }

        if (qqqResult.status === "fulfilled" && qqqResult.value.length > 0) {
            qqqCandles = qqqResult.value;
        } else if (qqqResult.status === "rejected") {
            console.warn("[MacroCorr] QQQ fetch failed:", qqqResult.reason);
        }

        if (btcResult.status === "fulfilled" && btcResult.value.length > 0) {
            btcCandles = btcResult.value;
        } else if (btcResult.status === "rejected") {
            console.warn("[MacroCorr] BTC fetch failed:", btcResult.reason);
        }
    } catch (err) {
        console.warn("[MacroCorr] Poll error:", err);
        return;
    }

    if (btcCandles.length < 10) {
        console.warn("[MacroCorr] Not enough BTC data yet");
        return;
    }

    // Extract return series for correlation
    const btcReturns = btcCandles
        .filter((c) => c.returnPct != null)
        .map((c) => c.returnPct!)
        .slice(-CORRELATION_WINDOW);

    const dxyReturns = dxyCandles
        .filter((c) => c.returnPct != null)
        .map((c) => c.returnPct!)
        .slice(-CORRELATION_WINDOW);

    const qqqReturns = qqqCandles
        .filter((c) => c.returnPct != null)
        .map((c) => c.returnPct!)
        .slice(-CORRELATION_WINDOW);

    const btcDxy = dxyReturns.length >= 10
        ? pearsonCorrelation(btcReturns, dxyReturns)
        : { pearson: 0, sampleSize: 0 };

    const btcQqq = qqqReturns.length >= 10
        ? pearsonCorrelation(btcReturns, qqqReturns)
        : { pearson: 0, sampleSize: 0 };

    const regime = detectRegime(btcDxy.pearson, btcQqq.pearson);
    const dxyTrend = getDxyTrend(dxyCandles);

    const reading: MacroReading = {
        timestamp: Date.now(),
        dxy: {
            price: dxyCandles.length > 0 ? dxyCandles[dxyCandles.length - 1]!.close : 0,
            change1h: calc1hChange(dxyCandles),
        },
        qqq: {
            price: qqqCandles.length > 0 ? qqqCandles[qqqCandles.length - 1]!.close : 0,
            change1h: calc1hChange(qqqCandles),
        },
        btc: {
            price: btcCandles.length > 0 ? btcCandles[btcCandles.length - 1]!.close : 0,
            change1h: calc1hChange(btcCandles),
        },
        correlations: { btcDxy, btcQqq },
        regime,
        dxyTrend,
        marketOpen,
    };

    history.push(reading);
    if (history.length > HISTORY_MAX) {
        history = history.slice(-HISTORY_MAX);
    }

    if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
        console.log(
            `[MacroCorr] BTC: $${reading.btc.price.toFixed(0)} / ` +
            `DXY: ${reading.dxy.price.toFixed(2)} (${dxyTrend}) / ` +
            `QQQ: $${reading.qqq.price.toFixed(2)} / ` +
            `r(BTC,DXY): ${btcDxy.pearson.toFixed(3)} / ` +
            `r(BTC,QQQ): ${btcQqq.pearson.toFixed(3)} / ` +
            `Regime: ${regime} / Market: ${marketOpen ? "OPEN" : "CLOSED"}`,
        );
        lastLogTime = Date.now();
    }
}

// ── Public API ──

export function getCurrentMacro(): MacroSnapshot | null {
    if (history.length === 0) return null;

    const latest = history[history.length - 1]!;
    const dxyImpact = getDxyImpact(latest.dxyTrend, latest.correlations.btcDxy.pearson);

    return {
        timestamp: latest.timestamp,
        dxy: latest.dxy,
        qqq: latest.qqq,
        btc: latest.btc,
        correlations: latest.correlations,
        regime: latest.regime,
        regimeDescription: regimeDescription(latest.regime),
        dxyTrend: latest.dxyTrend,
        dxyImpact,
        marketOpen: latest.marketOpen,
        history: history.map((r) => ({
            timestamp: r.timestamp,
            regime: r.regime,
            btcDxy: r.correlations.btcDxy.pearson,
            btcQqq: r.correlations.btcQqq.pearson,
        })),
    };
}

export function initMacroCorrelation(): void {
    if (interval) return;
    console.log("[MacroCorr] Service initialized, polling every 5min");
    poll();
    interval = setInterval(poll, POLL_MS);
}

export function stopMacroCorrelation(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
