interface OrderBookLevel {
    price: string;
    size: string;
}

interface CachedOrderBook {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    fetchedAt: number;
}

let cache: CachedOrderBook | null = null;
const CACHE_TTL_MS = 10_000;

async function fetchOrderBook(): Promise<CachedOrderBook> {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        return cache;
    }

    const url = "https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=BTC-USD&limit=5000";
    const res = await fetch(url);
    if (!res.ok) {
        console.warn(`[OrderBook] Coinbase API returned ${res.status}`);
        if (cache) return cache; // return stale cache
        return { bids: [], asks: [], fetchedAt: Date.now() };
    }

    const json = (await res.json()) as {
        pricebook: { bids: OrderBookLevel[]; asks: OrderBookLevel[] };
    };

    const book = json.pricebook;
    console.log(
        `[OrderBook] Fetched Coinbase order book: ${book.bids.length} bids, ${book.asks.length} asks`,
    );

    cache = {
        bids: book.bids,
        asks: book.asks,
        fetchedAt: Date.now(),
    };
    return cache;
}

export async function getDollarLiquidityAtPrice(
    targetPrice: number,
    rangePercent: number = 0.01,
): Promise<number> {
    try {
        const book = await fetchOrderBook();
        const low = targetPrice * (1 - rangePercent);
        const high = targetPrice * (1 + rangePercent);

        let dollarValue = 0;
        let bidsInRange = 0;
        let asksInRange = 0;
        for (const bid of book.bids) {
            const p = parseFloat(bid.price);
            if (p >= low && p <= high) {
                dollarValue += parseFloat(bid.size) * p;
                bidsInRange++;
            }
        }
        for (const ask of book.asks) {
            const p = parseFloat(ask.price);
            if (p >= low && p <= high) {
                dollarValue += parseFloat(ask.size) * p;
                asksInRange++;
            }
        }

        console.log(
            `[OrderBook] Zone $${targetPrice}: found ${bidsInRange} bids and ${asksInRange} asks in range $${low.toFixed(0)}-$${high.toFixed(0)}, total: $${dollarValue.toFixed(0)}`,
        );
        return dollarValue;
    } catch (err) {
        console.warn("[OrderBook] Failed to fetch liquidity:", (err as Error).message);
        return 0;
    }
}
