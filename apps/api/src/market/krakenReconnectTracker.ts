// Combined reconnect-attempt counter across BOTH independent Kraken WS
// connections (krakenWs.ts + footprintAggregator.ts) — diagnostic-only,
// added to test the theory in docs/followups.md (2026-08-13, Kraken WS
// instability) that two sockets racing to reconnect off the same IP after
// a shared network blip could be pushing toward Cloudflare's documented
// ~150 reconnects/10min per-IP ban threshold.
const WINDOW_MS = 10 * 60_000;
const attempts: number[] = [];

export function recordKrakenReconnectAttempt(): number {
    const now = Date.now();
    attempts.push(now);
    while (attempts.length > 0 && attempts[0]! < now - WINDOW_MS) {
        attempts.shift();
    }
    return attempts.length;
}
