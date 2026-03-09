/**
 * Order flow feature computation from order book depth data.
 *
 * Computes imbalance, depth, spread, whale detection, and wall detection
 * metrics from bid/ask arrays (25 levels from Kraken book channel).
 */

export interface BookLevel {
    price: number;
    qty: number;
}

export interface OrderFlowFeatures {
    // Imbalance
    bidAskImbalance: number;      // (bidVol - askVol) / (bidVol + askVol), range [-1, 1]
    weightedImbalance: number;    // Volume-weighted by distance from mid
    topLevelImbalance: number;    // Imbalance of just best bid/ask

    // Depth
    bidDepthUsd: number;          // Total bid volume in USD within 1%
    askDepthUsd: number;          // Total ask volume in USD within 1%
    depthRatio: number;           // bidDepth / askDepth

    // Spread
    spreadBps: number;            // Bid-ask spread in basis points

    // Whale detection
    largeOrderBid: boolean;       // Any single bid > 3x average level size
    largeOrderAsk: boolean;       // Any single ask > 3x average level size
    maxBidSize: number;           // Largest bid qty
    maxAskSize: number;           // Largest ask qty

    // Wall detection
    bidWallPrice: number | null;  // Price of largest bid concentration
    askWallPrice: number | null;  // Price of largest ask concentration
    bidWallDistance: number;       // Distance from mid to bid wall (%)
    askWallDistance: number;       // Distance from mid to ask wall (%)

    ts: number;
}

export function computeOrderFlowFeatures(
    bids: BookLevel[],
    asks: BookLevel[],
): Omit<OrderFlowFeatures, "ts"> {
    if (bids.length === 0 && asks.length === 0) {
        return emptyFeatures();
    }

    const bidVol = bids.reduce((s, b) => s + b.qty, 0);
    const askVol = asks.reduce((s, a) => s + a.qty, 0);
    const totalVol = bidVol + askVol;

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

    // 1. Simple imbalance
    const bidAskImbalance = totalVol > 0 ? (bidVol - askVol) / totalVol : 0;

    // 2. Weighted imbalance (closer to mid = higher weight)
    let wBid = 0;
    let wAsk = 0;
    for (const b of bids) {
        const dist = midPrice > 0 ? Math.abs(b.price - midPrice) / midPrice : 0;
        wBid += b.qty * (1 / (1 + dist * 100));
    }
    for (const a of asks) {
        const dist = midPrice > 0 ? Math.abs(a.price - midPrice) / midPrice : 0;
        wAsk += a.qty * (1 / (1 + dist * 100));
    }
    const wTotal = wBid + wAsk;
    const weightedImbalance = wTotal > 0 ? (wBid - wAsk) / wTotal : 0;

    // 3. Top-level imbalance
    const topBid = bids[0]?.qty ?? 0;
    const topAsk = asks[0]?.qty ?? 0;
    const topTotal = topBid + topAsk;
    const topLevelImbalance = topTotal > 0 ? (topBid - topAsk) / topTotal : 0;

    // 4. Depth within 1% of mid
    const threshold = midPrice * 0.01;
    const bidDepthUsd = bids
        .filter((b) => midPrice - b.price <= threshold)
        .reduce((s, b) => s + b.price * b.qty, 0);
    const askDepthUsd = asks
        .filter((a) => a.price - midPrice <= threshold)
        .reduce((s, a) => s + a.price * a.qty, 0);
    const depthRatio = askDepthUsd > 0 ? bidDepthUsd / askDepthUsd : 1;

    // 5. Spread
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    // 6. Whale / large order detection
    const avgBidSize = bidVol / Math.max(bids.length, 1);
    const avgAskSize = askVol / Math.max(asks.length, 1);
    const largeOrderBid = bids.some((b) => b.qty > avgBidSize * 3);
    const largeOrderAsk = asks.some((a) => a.qty > avgAskSize * 3);
    const maxBidSize = bids.reduce((m, b) => Math.max(m, b.qty), 0);
    const maxAskSize = asks.reduce((m, a) => Math.max(m, a.qty), 0);

    // 7. Wall detection (largest concentration)
    const bidWall = bids.length > 0
        ? bids.reduce((max, b) => (b.qty > max.qty ? b : max), bids[0]!)
        : { price: 0, qty: 0 };
    const askWall = asks.length > 0
        ? asks.reduce((max, a) => (a.qty > max.qty ? a : max), asks[0]!)
        : { price: 0, qty: 0 };

    return {
        bidAskImbalance: round4(bidAskImbalance),
        weightedImbalance: round4(weightedImbalance),
        topLevelImbalance: round4(topLevelImbalance),
        bidDepthUsd: Math.round(bidDepthUsd),
        askDepthUsd: Math.round(askDepthUsd),
        depthRatio: Math.round(depthRatio * 100) / 100,
        spreadBps: Math.round(spreadBps * 10) / 10,
        largeOrderBid,
        largeOrderAsk,
        maxBidSize,
        maxAskSize,
        bidWallPrice: bidWall.qty > avgBidSize * 2 ? bidWall.price : null,
        askWallPrice: askWall.qty > avgAskSize * 2 ? askWall.price : null,
        bidWallDistance: midPrice > 0
            ? Math.round(((midPrice - bidWall.price) / midPrice) * 10000) / 100
            : 0,
        askWallDistance: midPrice > 0
            ? Math.round(((askWall.price - midPrice) / midPrice) * 10000) / 100
            : 0,
    };
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

function emptyFeatures(): Omit<OrderFlowFeatures, "ts"> {
    return {
        bidAskImbalance: 0,
        weightedImbalance: 0,
        topLevelImbalance: 0,
        bidDepthUsd: 0,
        askDepthUsd: 0,
        depthRatio: 1,
        spreadBps: 0,
        largeOrderBid: false,
        largeOrderAsk: false,
        maxBidSize: 0,
        maxAskSize: 0,
        bidWallPrice: null,
        askWallPrice: null,
        bidWallDistance: 0,
        askWallDistance: 0,
    };
}

// ---------------------------------------------------------------------------
// In-memory caches (written by krakenWs, read by API + snapshot job)
// ---------------------------------------------------------------------------

/** Raw book snapshots: pairId → {bids, asks, ts} */
export const bookSnapshots = new Map<string, {
    bids: BookLevel[];
    asks: BookLevel[];
    ts: number;
}>();

/** Computed order flow features: pairId → features */
export const orderFlowCache = new Map<string, OrderFlowFeatures>();

/**
 * Get current order flow features for a pair (from cache).
 * Returns null if no book data has been received yet.
 */
export function getOrderFlow(pairId: string): OrderFlowFeatures | null {
    return orderFlowCache.get(pairId) ?? null;
}

/**
 * Get all cached order flow features (for snapshot job).
 */
export function getAllOrderFlow(): Map<string, OrderFlowFeatures> {
    return orderFlowCache;
}
