import { useEffect, useState } from "react";
import { getPublicTickers, type PublicTicker } from "@/api/endpoints/marketData";

/** Display row for the scrolling ticker strips (login / landing / replay). */
export interface TickerItem {
  sym: string;   // "BTC"
  price: string; // "$84,220.44"
  chg: string;   // "+2.31%" or "—"
  up: boolean;
}

const POLL_MS = 15_000;

/**
 * Items for a scrolling strip. The CSS loop translates by -50%, so the list
 * must be two identical halves; each half repeats the 3 symbols 3x so it is
 * wide enough to fill the bar (the old fake list had 6–8 entries).
 */
export function tickerLoop<T>(items: readonly T[]): T[] {
  const half = [...items, ...items, ...items];
  return [...half, ...half];
}

export function formatTickerPrice(price: number): string {
  const digits = price >= 1 ? 2 : 4;
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Map API rows to display rows; rows without a price are dropped. */
export function toTickerItems(rows: readonly PublicTicker[]): TickerItem[] {
  const items: TickerItem[] = [];
  for (const r of rows) {
    const price = r.price == null ? NaN : Number(r.price);
    if (!Number.isFinite(price)) continue;
    const chg = r.change24hPct;
    items.push({
      sym: r.symbol.split("/")[0]!,
      price: formatTickerPrice(price),
      chg: chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
      up: (chg ?? 0) >= 0,
    });
  }
  return items;
}

/**
 * Real BTC/ETH/SOL prices for the ticker strips, polled every 15s. Returns []
 * until the first successful fetch (and keeps the last good data on a failed
 * poll) — callers hide the strip when it's empty rather than show fake prices.
 */
export function usePublicTicker(): TickerItem[] {
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getPublicTickers()
        .then((res) => {
          if (!cancelled) setItems(toTickerItems(res.data.data));
        })
        .catch(() => {
          // keep whatever we last showed
        });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return items;
}
