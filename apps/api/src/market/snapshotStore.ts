export type Snapshot = {
    bid: string | null;
    ask: string | null;
    last: string;
    ts: string;
    source: "live" | "replay" | "fallback";
};

type CachedSnapshot = Omit<Snapshot, "source"> & { receivedAt: number };

const store = new Map<string, CachedSnapshot>();

const DEFAULT_STALE_TTL_MS = 10_000;

export function setSnapshot(pairSymbol: string, snap: Omit<Snapshot, "source">): void {
    store.set(pairSymbol, { ...snap, receivedAt: Date.now() });
}

export function getSnapshot(pairSymbol: string, staleTtlMs: number = DEFAULT_STALE_TTL_MS): Snapshot | null {
    const entry = store.get(pairSymbol);
    if (!entry) return null;

    if (Date.now() - entry.receivedAt > staleTtlMs) return null;

    return {
        bid: entry.bid,
        ask: entry.ask,
        last: entry.last,
        ts: entry.ts,
        source: "live",
    };
}