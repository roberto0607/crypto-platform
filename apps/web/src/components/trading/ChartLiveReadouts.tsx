/**
 * The chart's per-tick readouts, outside CandlestickChart so a price tick
 * re-renders only them, not the whole chart component:
 *
 * - createLiveTick / LiveTick: a tiny per-chart store the tick handler
 *   publishes to; <LiveTick store>{() => …}</LiveTick> re-renders its children
 *   on every tick (they read the chart's refs: current price, forming candle).
 * - ChartHeroPrice: the legend's hero price (+ tick flash) and FILL SPREAD,
 *   subscribed to the trading snapshot / pair prices itself.
 */
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PRICE_HELP } from "@/lib/priceHelp";
import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";

export interface LiveTickStore {
    publish(): void;
    subscribe(onChange: () => void): () => void;
    version(): number;
}

export function createLiveTick(): LiveTickStore {
    let v = 0;
    const subs = new Set<() => void>();
    return {
        publish() {
            v++;
            for (const f of subs) f();
        },
        subscribe(f) {
            subs.add(f);
            return () => { subs.delete(f); };
        },
        version: () => v,
    };
}

/** Re-renders `children()` on every published tick (and whenever the parent renders). */
export function LiveTick({ store, children }: { store: LiveTickStore; children: () => ReactNode }) {
    useSyncExternalStore(store.subscribe, store.version);
    return <Fragment>{children()}</Fragment>;
}

/** Hero price + FILL SPREAD (snapshot-first is load-bearing for replay mode; see AssetTab.tsx). */
export function ChartHeroPrice({ pairId, dayDir }: { pairId: string | null; dayDir: "up" | "down" | "flat" }) {
    const snapshot = useTradingStore((s) => s.snapshot);
    const pairPrice = usePairPricesStore((s) => (pairId ? s.prices[pairId] : undefined));
    const heroPrice = snapshot?.last ? parseFloat(snapshot.last) : pairPrice ?? 0;

    // Tick FLASH — brief pulse on real movement between ticks, layered on top
    // of the persistent day color.
    const heroPrevPriceRef = useRef<number | null>(null);
    const [heroTickFlash, setHeroTickFlash] = useState<"" | "tick-up" | "tick-down">("");
    const heroFlashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        heroPrevPriceRef.current = null;
        clearTimeout(heroFlashTimerRef.current);
        setHeroTickFlash("");
    }, [pairId]);

    useEffect(() => {
        if (!heroPrice) return;
        const prev = heroPrevPriceRef.current;
        heroPrevPriceRef.current = heroPrice;
        if (prev === null || heroPrice === prev) return;
        setHeroTickFlash(heroPrice > prev ? "tick-up" : "tick-down");
        clearTimeout(heroFlashTimerRef.current);
        heroFlashTimerRef.current = setTimeout(() => setHeroTickFlash(""), 150);
    }, [heroPrice]);

    useEffect(() => () => clearTimeout(heroFlashTimerRef.current), []);

    return (
        <div className="tr-chart-legend-row">
            <span className={`tr-price-big ${dayDir} ${heroTickFlash}`} title={PRICE_HELP.last} data-testid="chart-hero-price">
                ${heroPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            <span className="tr-price-tag" title={PRICE_HELP.last}>LAST</span>
            <div className="tr-price-meta">
                <div className="tr-pm-item">
                    <div className="tr-pm-val" style={{ color: "rgba(255,255,255,0.7)" }}>
                        {(() => {
                            const ask = snapshot?.ask ? parseFloat(snapshot.ask) : 0;
                            const bid = snapshot?.bid ? parseFloat(snapshot.bid) : 0;
                            if (!(ask > 0) || !(bid > 0)) return "—";
                            const spreadDollars = ask - bid;
                            const midPrice = (ask + bid) / 2;
                            if (midPrice === 0) return "—";
                            const spreadPct = (spreadDollars / midPrice) * 100;
                            return `$${spreadDollars.toFixed(2)} (${spreadPct.toFixed(4)}%)`;
                        })()}
                    </div>
                    <div className="tr-pm-lbl">FILL SPREAD</div>
                </div>
            </div>
        </div>
    );
}
