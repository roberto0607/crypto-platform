import type Redis from "ioredis";
import { getRedis } from "../db/redis.js";

export type Snapshot = {
    bid: string | null;
    ask: string | null;
    last: string;
    ts: string;
    source: "live" | "replay" | "fallback";
};

export type CachedSnapshot = Omit<Snapshot, "source"> & { receivedAt: number };

const DEFAULT_STALE_TTL_MS = 10_000;

// ── Interface ──

interface SnapshotStore {
    setSnapshot(pairSymbol: string, snap: Omit<Snapshot, "source">): Promise<void>;
    getSnapshot(pairSymbol: string, staleTtlMs?: number): Promise<Snapshot | null>;
    peekSnapshot(pairSymbol: string): Promise<CachedSnapshot | null>;
}

// ── Redis implementation (HASH) ──

class RedisSnapshotStore implements SnapshotStore {
    constructor(private redis: Redis) {}

    async setSnapshot(pairSymbol: string, snap: Omit<Snapshot, "source">): Promise<void> {
        const key = `snap:${pairSymbol}`;
        const now = Date.now();
        const pipeline = this.redis.pipeline();
        pipeline.hset(key,
            "bid", snap.bid ?? "",
            "ask", snap.ask ?? "",
            "last", snap.last,
            "ts", snap.ts,
            "receivedAt", now.toString(),
        );
        pipeline.expire(key, Math.ceil(DEFAULT_STALE_TTL_MS / 1000) + 5);
        await pipeline.exec();
    }

    async getSnapshot(pairSymbol: string, staleTtlMs: number = DEFAULT_STALE_TTL_MS): Promise<Snapshot | null> {
        const key = `snap:${pairSymbol}`;
        const data = await this.redis.hgetall(key);
        if (!data || !data.last) return null;

        const receivedAt = parseInt(data.receivedAt, 10);
        if (Date.now() - receivedAt > staleTtlMs) return null;

        return {
            bid: data.bid || null,
            ask: data.ask || null,
            last: data.last,
            ts: data.ts,
            source: "live",
        };
    }

    async peekSnapshot(pairSymbol: string): Promise<CachedSnapshot | null> {
        const data = await this.redis.hgetall(`snap:${pairSymbol}`);
        if (!data || !data.last) return null;
        return {
            bid: data.bid || null,
            ask: data.ask || null,
            last: data.last,
            ts: data.ts,
            receivedAt: parseInt(data.receivedAt, 10),
        };
    }
}

// ── In-memory implementation ──

class InMemorySnapshotStore implements SnapshotStore {
    private store = new Map<string, CachedSnapshot>();

    async setSnapshot(pairSymbol: string, snap: Omit<Snapshot, "source">): Promise<void> {
        this.store.set(pairSymbol, { ...snap, receivedAt: Date.now() });
    }

    async getSnapshot(pairSymbol: string, staleTtlMs: number = DEFAULT_STALE_TTL_MS): Promise<Snapshot | null> {
        const entry = this.store.get(pairSymbol);
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

    async peekSnapshot(pairSymbol: string): Promise<CachedSnapshot | null> {
        return this.store.get(pairSymbol) ?? null;
    }
}

// ── Factory + singleton ──

let _instance: SnapshotStore | null = null;

function getInstance(): SnapshotStore {
    if (!_instance) {
        const redis = getRedis();
        _instance = redis ? new RedisSnapshotStore(redis) : new InMemorySnapshotStore();
    }
    return _instance;
}

export async function setSnapshot(pairSymbol: string, snap: Omit<Snapshot, "source">): Promise<void> {
    return getInstance().setSnapshot(pairSymbol, snap);
}

export async function getSnapshot(pairSymbol: string, staleTtlMs: number = DEFAULT_STALE_TTL_MS): Promise<Snapshot | null> {
    return getInstance().getSnapshot(pairSymbol, staleTtlMs);
}

/**
 * Diagnostic read that ignores the stale TTL — returns the raw cached entry
 * with its receivedAt so callers can report its age. Never use this for
 * pricing. With Redis the key itself expires ~15s after the last write, so
 * an older snapshot reads back as null.
 */
export async function peekSnapshot(pairSymbol: string): Promise<CachedSnapshot | null> {
    return getInstance().peekSnapshot(pairSymbol);
}
