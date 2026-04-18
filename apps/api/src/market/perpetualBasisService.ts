/**
 * perpetualBasisService.ts — Tracks BTC spot vs perpetual futures basis in real time.
 *
 * Data sources (all public, no auth):
 *   Spot:     Coinbase order book mid-price
 *   Perp:     Deribit BTC-PERPETUAL ticker
 *   Funding:  Deribit funding rate
 */

interface BasisReading {
    timestamp: number;
    spotPrice: number;
    perpPrice: number;
    basisDollar: number;
    basisPercent: number;
    fundingRate: number;
}

interface BasisSnapshot {
    timestamp: number;
    spotPrice: number;
    perpPrice: number;
    basisDollar: number;
    basisPercent: number;
    fundingRate: number;
    fundingRateAnnualized: number;
    crowding: string;
    trend: string;
    history: { timestamp: number; basisPercent: number; fundingRate: number }[];
}

const HISTORY_MAX = 288; // 288 × 5s = 24 hours
const POLL_MS = 5_000;
const LOG_INTERVAL_MS = 60_000;

let history: BasisReading[] = [];
let lastLogTime = 0;
let interval: ReturnType<typeof setInterval> | null = null;

// ── Fetchers ──

async function fetchSpotPrice(): Promise<number | null> {
    const res = await fetch(
        "https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=BTC-USD&limit=1",
    );
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    const json = (await res.json()) as {
        pricebook: { bids: { price: string }[]; asks: { price: string }[] };
    };
    if (!json.pricebook?.bids?.length || !json.pricebook?.asks?.length) {
        return null; // caller should handle null basis
    }
    const bid = parseFloat(json.pricebook.bids[0]!.price);
    const ask = parseFloat(json.pricebook.asks[0]!.price);
    return (bid + ask) / 2;
}

async function fetchDeribitTicker(): Promise<{ perpPrice: number; fundingRate: number }> {
    const res = await fetch(
        "https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL",
    );
    if (!res.ok) throw new Error(`Deribit ${res.status}`);
    const json = (await res.json()) as {
        result: {
            mark_price: number;
            last_price: number;
            current_funding: number;
            funding_8h: number;
        };
    };
    const r = json.result;
    return {
        perpPrice: r.mark_price,
        fundingRate: r.funding_8h || r.current_funding || 0,
    };
}

// ── Signal logic ──

function computeCrowding(basisPercent: number): string {
    if (basisPercent > 0.15) return "LONGS_CROWDED";
    if (basisPercent < -0.15) return "SHORTS_CROWDED";
    if (basisPercent >= -0.05 && basisPercent <= 0.05) return "NEUTRAL";
    if (basisPercent > 0) return "SLIGHT_LONG_BIAS";
    return "SLIGHT_SHORT_BIAS";
}

function computeTrend(readings: BasisReading[]): string {
    if (readings.length < 12) return "STABLE";
    const recent = readings.slice(-12);
    const last3 = recent.slice(-3).map((r) => r.basisPercent);
    const prev3 = recent.slice(-6, -3).map((r) => r.basisPercent);

    const last3Min = Math.min(...last3);
    const prev3Max = Math.max(...prev3);
    if (last3Min > prev3Max) return "EXPANDING_LONG";

    const last3Max = Math.max(...last3);
    const prev3Min = Math.min(...prev3);
    if (last3Max < prev3Min) return "EXPANDING_SHORT";

    return "STABLE";
}

// ── Poll ──

async function poll(): Promise<void> {
    try {
        const [spotPrice, deribit] = await Promise.all([
            fetchSpotPrice(),
            fetchDeribitTicker(),
        ]);

        if (spotPrice === null || spotPrice === 0) {
            console.warn("[PerpBasis] Empty Coinbase book — skipping this poll");
            return;
        }

        const basisDollar = deribit.perpPrice - spotPrice;
        const basisPercent = (basisDollar / spotPrice) * 100;

        const reading: BasisReading = {
            timestamp: Date.now(),
            spotPrice,
            perpPrice: deribit.perpPrice,
            basisDollar,
            basisPercent,
            fundingRate: deribit.fundingRate,
        };

        history.push(reading);
        if (history.length > HISTORY_MAX) {
            history = history.slice(-HISTORY_MAX);
        }

        // Log every 60s
        if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
            const crowding = computeCrowding(basisPercent);
            console.log(
                `[PerpBasis] spot: $${spotPrice.toFixed(0)}, perp: $${deribit.perpPrice.toFixed(0)}, ` +
                `basis: $${basisDollar.toFixed(2)} (${basisPercent.toFixed(4)}%), ` +
                `funding: ${(deribit.fundingRate * 100).toFixed(6)}%, crowding: ${crowding}`,
            );
            lastLogTime = Date.now();
        }
    } catch (err) {
        console.warn("[PerpBasis] Warning: fetch failed, using last known values —", (err as Error).message);
    }
}

// ── Public API ──

export function getCurrentBasis(): BasisSnapshot | null {
    if (history.length === 0) return null;

    const latest = history[history.length - 1]!;
    const crowding = computeCrowding(latest.basisPercent);
    const trend = computeTrend(history);
    // funding_8h → annualized: rate × 3 periods/day × 365 days × 100 for percent
    const fundingRateAnnualized = latest.fundingRate * 3 * 365 * 100;

    return {
        timestamp: latest.timestamp,
        spotPrice: latest.spotPrice,
        perpPrice: latest.perpPrice,
        basisDollar: latest.basisDollar,
        basisPercent: latest.basisPercent,
        fundingRate: latest.fundingRate,
        fundingRateAnnualized,
        crowding,
        trend,
        history: history.map((r) => ({
            timestamp: r.timestamp,
            basisPercent: r.basisPercent,
            fundingRate: r.fundingRate,
        })),
    };
}

export function initPerpetualBasis(): void {
    if (interval) return;
    console.log("[PerpBasis] Service initialized, polling every 5s");
    // Fire first poll immediately, then every 5s
    poll();
    interval = setInterval(poll, POLL_MS);
}

export function stopPerpetualBasis(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
