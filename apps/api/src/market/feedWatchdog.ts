/**
 * feedWatchdog.ts — pure staleness + reconnect-backoff logic for the exchange
 * WS feeds. No sockets, no timers, no I/O: every method takes `now`, so the
 * feeds own the wiring and the tests drive time directly.
 *
 * StalenessTracker: last-message time per key (a symbol, or "heartbeat").
 *   - A key's clock starts at its first message after (re)connect, not at
 *     connect — a slow resubscribe/snapshot must not read as stale.
 *   - A key with no message yet is stale only once `graceMs` has passed since
 *     it was first expected (connect, or the first check that saw it — so a
 *     symbol added mid-connection gets its own grace).
 *   - check() reports each stale episode once (on the transition into stale),
 *     so a 1s check loop logs/kills once per episode, not once per second.
 *   - A check that runs more than `maxCheckGapMs` after the previous one is
 *     skipped: the event loop was blocked, so buffered messages haven't been
 *     processed yet and every key would read as falsely stale.
 *
 * ReconnectBackoff: exponential delay (base × 2^attempt, capped) with ±jitter.
 * The attempt counter resets only once the connection has been delivering data
 * for `healthyResetMs` — never on `open` — so a socket that connects and then
 * flaps (or goes stale) keeps backing off. A caller-supplied budget flag forces
 * the cap delay (the shared Kraken reconnects-per-10-min budget).
 */

/** Backoff shape for every exchange socket (each keeps its own ReconnectBackoff
 *  instance): 1s doubling to a 60s cap, ±20% jitter, reset only after 60s of
 *  real data — never on open. */
export const FEED_BACKOFF = { baseMs: 1_000, maxMs: 60_000, jitter: 0.2, healthyResetMs: 60_000 } as const;

export interface StaleEpisode {
    key: string;
    /** Time since the last message (or since grace started, if none yet). */
    silentMs: number;
    /** False when the key has never sent a message since connect. */
    seenSinceConnect: boolean;
}

export interface StalenessTrackerOptions {
    staleMs: number;
    graceMs: number;
    maxCheckGapMs: number;
}

export class StalenessTracker {
    private lastAt = new Map<string, number>();
    private expectedSince = new Map<string, number>();
    private stale = new Set<string>();
    private connectedAt: number | null = null;
    private lastCheckAt: number | null = null;

    constructor(private readonly opts: StalenessTrackerOptions) {}

    get staleMs(): number {
        return this.opts.staleMs;
    }

    /** New connection: forget everything from the previous socket. */
    reset(now: number): void {
        this.lastAt.clear();
        this.expectedSince.clear();
        this.stale.clear();
        this.connectedAt = now;
        this.lastCheckAt = null;
    }

    /** Disconnected: nothing is being watched until the next reset(). */
    disconnect(): void {
        this.connectedAt = null;
        this.lastAt.clear();
        this.expectedSince.clear();
        this.stale.clear();
        this.lastCheckAt = null;
    }

    record(key: string, now: number): void {
        this.lastAt.set(key, now);
        this.stale.delete(key);
    }

    /** ms since the key's last message on this connection, or null if none yet. */
    ageOf(key: string, now: number): number | null {
        const at = this.lastAt.get(key);
        return at === undefined ? null : now - at;
    }

    isStale(key: string): boolean {
        return this.stale.has(key);
    }

    /** When the key's current silence began: its last message, else when it was first expected. */
    silentSince(key: string): number | null {
        return this.lastAt.get(key) ?? this.expectedSince.get(key) ?? null;
    }

    /** New stale episodes among `keys` (each reported once until the key recovers). */
    check(keys: readonly string[], now: number): StaleEpisode[] {
        if (this.connectedAt === null) return [];

        const prevCheck = this.lastCheckAt;
        this.lastCheckAt = now;
        if (prevCheck !== null && now - prevCheck > this.opts.maxCheckGapMs) return [];

        const episodes: StaleEpisode[] = [];
        for (const key of keys) {
            const last = this.lastAt.get(key);
            let silentMs: number;
            let isStale: boolean;
            if (last !== undefined) {
                silentMs = now - last;
                isStale = silentMs > this.opts.staleMs;
            } else {
                let since = this.expectedSince.get(key);
                if (since === undefined) {
                    since = Math.max(this.connectedAt, prevCheck ?? this.connectedAt);
                    this.expectedSince.set(key, since);
                }
                silentMs = now - since;
                isStale = silentMs > this.opts.graceMs;
            }

            if (isStale && !this.stale.has(key)) {
                this.stale.add(key);
                episodes.push({ key, silentMs, seenSinceConnect: last !== undefined });
            }
        }
        return episodes;
    }
}

export interface ReconnectBackoffOptions {
    baseMs: number;
    maxMs: number;
    /** Fraction, e.g. 0.2 = ±20%. */
    jitter: number;
    healthyResetMs: number;
    random?: () => number;
}

export class ReconnectBackoff {
    private attempt = 0;
    private openedAt: number | null = null;
    private readonly random: () => number;

    constructor(private readonly opts: ReconnectBackoffOptions) {
        this.random = opts.random ?? Math.random;
    }

    get attempts(): number {
        return this.attempt;
    }

    onOpen(now: number): void {
        this.openedAt = now;
    }

    /** Call on real data (not heartbeats). Resets the backoff once the socket has been healthy long enough. */
    onHealthy(now: number): void {
        if (this.attempt > 0 && this.openedAt !== null && now - this.openedAt >= this.opts.healthyResetMs) {
            this.attempt = 0;
        }
    }

    /** Delay before the next reconnect. Consumes one attempt. */
    nextDelay(opts: { budgetExceeded?: boolean } = {}): number {
        this.openedAt = null;
        if (opts.budgetExceeded) {
            this.attempt++;
            return this.opts.maxMs;
        }
        const raw = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** Math.min(this.attempt, 30));
        this.attempt++;
        const factor = 1 + (this.random() * 2 - 1) * this.opts.jitter;
        return Math.round(Math.min(this.opts.maxMs, raw * factor));
    }
}
