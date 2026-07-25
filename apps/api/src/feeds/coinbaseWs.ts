import WebSocket from "ws";
import { loadActiveSymbols, type ActiveSymbol } from "../market/symbolRegistry.js";
import { aggregateTick } from "../market/candleAggregator.js";
import { logger } from "../observability/logContext.js";
import { coinbaseTradeSide, addSample as addPressureSample } from "../services/pressureAggregator.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { eventsPublishedTotal } from "../metrics.js";

const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";

/**
 * Coinbase's documented WS limits (live-checked docs.cdp.coinbase.com/
 * coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits) are
 * connection-rate (8/sec/IP) and unauthenticated-message-rate (8/sec/IP) —
 * there is no documented per-connection product_ids ceiling. At the current
 * curated universe size (~75 pairs) a single connection covers everything
 * in one subscribe message, well under both limits. This is still
 * structured around N batched connections (not a bare module-level `ws`)
 * so growing the universe past one batch is a constant change, not a
 * rewrite — see docs/designs/2026-07-22-multi-asset-datafeed-gate1.md
 * section 2.4 for the full rationale.
 */
const COINBASE_WS_BATCH_SIZE = 150;

const SYMBOL_REFRESH_INTERVAL_MS = 5 * 60_000;
const PAIR_CACHE_RETRY_MS = 60_000;
const MAX_RECONNECT_DELAY = 30_000;

// our symbol → pair UUID, keyed off Coinbase product_id (== wsSymbol here).
let productIdToPairId: Record<string, string> = {};
let productIdToOurSymbol: Record<string, string> = {};
let symbolRefreshInterval: ReturnType<typeof setInterval> | null = null;
let pairCacheRetryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let tradeCount = 0;

// Global (not per-pair) liveness signal — mirrors krakenWs.ts's own
// lastTickAt watchdog pattern. krakenWs.ts's ticker handler reads this via
// getCoinbaseLastTradeAt() to decide whether to fall back to publishing
// price.tick itself, since this feed (unlike Kraken's) has no app-level
// staleness watchdog of its own — see docs/designs/2026-07-25-price-tick-
// coinbase-source-gate1.md section 2.
let lastTradeAt = 0;

export function getCoinbaseLastTradeAt(): number {
    return lastTradeAt;
}

interface Batch {
    index: number;
    productIds: string[];
    ws: WebSocket | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    reconnectDelay: number;
}

const batches = new Map<number, Batch>();

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function refreshSymbols(): Promise<ActiveSymbol[]> {
    try {
        const symbols = await loadActiveSymbols("coinbase");
        productIdToPairId = Object.fromEntries(symbols.map((s) => [s.wsSymbol, s.pairId]));
        productIdToOurSymbol = Object.fromEntries(symbols.map((s) => [s.wsSymbol, s.ourSymbol]));
        if (pairCacheRetryTimer) {
            clearTimeout(pairCacheRetryTimer);
            pairCacheRetryTimer = null;
        }
        return symbols;
    } catch (err) {
        logger.error({ err }, "coinbase_symbol_refresh_failed");
        // Retry every 60s until successful — otherwise a DB outage at boot
        // leaves the map empty forever and incoming trades are discarded.
        if (!pairCacheRetryTimer && !stopped) {
            pairCacheRetryTimer = setTimeout(() => {
                pairCacheRetryTimer = null;
                refreshSymbols();
            }, PAIR_CACHE_RETRY_MS);
        }
        return [];
    }
}

function subscribeMessage(type: "subscribe" | "unsubscribe", productIds: string[]) {
    return JSON.stringify({ type, product_ids: productIds, channel: "market_trades" });
}

function handleMessage(raw: WebSocket.Data): void {
    try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel !== "market_trades") return;

        const events: any[] = msg.events;
        if (!events) return;

        for (const event of events) {
            const trades: any[] = event.trades;
            if (!trades) continue;

            for (const trade of trades) {
                const productId: string = trade.product_id;
                const ourSymbol = productIdToOurSymbol[productId];
                if (!ourSymbol) continue;

                const pairId = productIdToPairId[productId];
                if (!pairId) continue;

                const price = String(trade.price);
                const volume = String(trade.size);
                const ts = trade.time
                    ? new Date(trade.time).getTime()
                    : Date.now();
                // Coinbase sends "BUY" or "SELL" (taker side) — normalize.
                const side = coinbaseTradeSide(trade);

                aggregateTick(pairId, { price, volume, ts, side });

                // Pressure aggregator hook — runs AFTER aggregateTick so a
                // failure here can never break the existing CVD/candle path.
                if (side) {
                    try {
                        addPressureSample(ourSymbol, {
                            ts,
                            side,
                            notional: Number(price) * Number(volume),
                        });
                    } catch {
                        // Pressure ingestion must never disrupt the trade feed.
                    }
                }

                lastTradeAt = Date.now();

                // Primary price.tick source (Gate 1, 2026-07-25) — Coinbase's
                // trade prints carry far more volume than Kraken's ticker
                // channel across this pair set. bid/ask are null: market_trades
                // is a trade print, not a quote, and this feed isn't
                // subscribed to a Coinbase order-book/ticker channel. See
                // docs/designs/2026-07-25-price-tick-coinbase-source-gate1.md.
                try {
                    publish(createEvent("price.tick", {
                        pairId,
                        symbol: ourSymbol,
                        bid: null,
                        ask: null,
                        last: price,
                    }));
                    eventsPublishedTotal.inc({ type: "price.tick" });
                } catch {
                    // Events must never break the trade feed.
                }

                tradeCount++;
                if (tradeCount % 50 === 0) {
                    console.log(`[coinbaseWs] ${tradeCount} trades ingested (latest: ${ourSymbol} ${price} ${side ?? "?"})`);
                }
            }
        }
    } catch {
        // Ignore unparseable messages (heartbeats, subscriptions, etc.)
    }
}

function connectBatch(batch: Batch): void {
    if (stopped) return;

    batch.ws = new WebSocket(COINBASE_WS_URL);

    batch.ws.on("open", () => {
        console.log(`[coinbaseWs] batch ${batch.index} connected (${batch.productIds.length} products)`);
        batch.reconnectDelay = 1000;
        batch.ws!.send(subscribeMessage("subscribe", batch.productIds));
    });

    batch.ws.on("message", handleMessage);

    batch.ws.on("close", () => {
        scheduleBatchReconnect(batch);
    });

    batch.ws.on("error", (err) => {
        console.error(`[coinbaseWs] batch ${batch.index} error`, err.message);
        batch.ws?.close();
    });
}

function scheduleBatchReconnect(batch: Batch): void {
    if (stopped) return;
    if (batch.reconnectTimer) return;

    console.log(`[coinbaseWs] batch ${batch.index} reconnecting in ${batch.reconnectDelay}ms`);
    batch.reconnectTimer = setTimeout(() => {
        batch.reconnectTimer = null;
        connectBatch(batch);
        batch.reconnectDelay = Math.min(batch.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, batch.reconnectDelay);
}

function teardownBatch(batch: Batch): void {
    if (batch.reconnectTimer) {
        clearTimeout(batch.reconnectTimer);
        batch.reconnectTimer = null;
    }
    if (batch.ws) {
        batch.ws.close();
        batch.ws = null;
    }
}

/**
 * Reconcile the batch connections against the current active symbol set:
 * new batches get a fresh connection, batches whose product list changed
 * get an incremental subscribe/unsubscribe on their existing connection (no
 * reconnect), and batches that no longer exist (universe shrank below a
 * prior batch count) get torn down.
 */
async function reconcileBatches(): Promise<void> {
    const symbols = await refreshSymbols();
    const productIds = symbols.map((s) => s.wsSymbol);
    const chunks = chunk(productIds, COINBASE_WS_BATCH_SIZE);

    for (let i = 0; i < chunks.length; i++) {
        const newProductIds = chunks[i]!;
        const existing = batches.get(i);

        if (!existing) {
            const batch: Batch = { index: i, productIds: newProductIds, ws: null, reconnectTimer: null, reconnectDelay: 1000 };
            batches.set(i, batch);
            connectBatch(batch);
            continue;
        }

        const before = new Set(existing.productIds);
        const after = new Set(newProductIds);
        const added = newProductIds.filter((p) => !before.has(p));
        const removed = existing.productIds.filter((p) => !after.has(p));
        existing.productIds = newProductIds;

        if ((added.length > 0 || removed.length > 0) && existing.ws?.readyState === WebSocket.OPEN) {
            if (added.length > 0) existing.ws.send(subscribeMessage("subscribe", added));
            if (removed.length > 0) existing.ws.send(subscribeMessage("unsubscribe", removed));
            logger.info({ batch: i, added, removed }, "coinbase_ws_subscriptions_reconciled");
        }
    }

    // Tear down batches beyond the current chunk count (universe shrank).
    for (const [index, batch] of batches) {
        if (index >= chunks.length) {
            teardownBatch(batch);
            batches.delete(index);
        }
    }
}

export function startCoinbaseFeed(): void {
    stopped = false;
    reconcileBatches().catch((err: unknown) => {
        logger.error({ err }, "coinbase_ws_initial_connect_failed");
    });

    if (!symbolRefreshInterval) {
        symbolRefreshInterval = setInterval(() => {
            reconcileBatches().catch((err: unknown) => {
                logger.error({ err }, "coinbase_ws_symbol_reconcile_failed");
            });
        }, SYMBOL_REFRESH_INTERVAL_MS);
    }
}

export function stopCoinbaseFeed(): void {
    stopped = true;
    if (symbolRefreshInterval) {
        clearInterval(symbolRefreshInterval);
        symbolRefreshInterval = null;
    }
    if (pairCacheRetryTimer) {
        clearTimeout(pairCacheRetryTimer);
        pairCacheRetryTimer = null;
    }
    for (const batch of batches.values()) teardownBatch(batch);
    batches.clear();
}
