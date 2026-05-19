import { useEffect, useState, type CSSProperties } from "react";

/**
 * PressureCell — Cell 4 of the Market Context Bar.
 *
 * Subscribes to the buy/sell pressure aggregator SSE stream (Commit A) and
 * renders live aggressor-side pressure as a thin split bar with percentage
 * labels. Part 3 of 3 for the Market Context Bar.
 *
 * The pressure stream is unauthenticated (matching its sibling public
 * /v1/market/* endpoints), so this uses the native EventSource — which also
 * handles named events and `: heartbeat` comments for free. The authenticated
 * /v1/events singleton in api/sse.ts is a different scope and not reused here.
 *
 * Refs: docs/architecture/market-context-bar.md (Commit C)
 */

/** Subset of the aggregator's PressureSnapshot consumed by this cell. */
interface PressureSnapshot {
    pair: string;
    buyPct: number;   // 0-100 integer
    sellPct: number;  // 0-100 integer, derived ⇒ buyPct + sellPct === 100
    stale: boolean;   // true if the aggregator saw no samples in the last 60s
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// Exponential reconnect backoff: 1s → 2s → 4s → 8s, capped at 30s. The stream
// is not rate-limited server-side, so this only avoids hammering a hard
// outage — politeness is not the concern.
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000];

// No `pressure` event for this long ⇒ treat the readout as stale. The server
// pushes a 10s floor plus 15s heartbeats, so a healthy stream never trips
// this — it only fires on an actual disconnect.
const STALE_TIMEOUT_MS = 30_000;

// Loading and stale share this muted treatment. Tuned for legibility
// against the near-black chart toolbar — 0.15/0.3 alpha read as blank space
// at this font/bar size; 0.25/0.45 stay clearly muted vs the live state
// (full --g/--red + 0.7 white) while remaining visible from t=0.
const MUTED_TEXT = "rgba(255,255,255,0.45)";
const MUTED_BAR = "rgba(255,255,255,0.25)";

// Persistent groove behind the split bar — keeps the 54px bar slot visible
// before the first event lands, so the cell never reads as empty.
const BAR_TRACK = "rgba(255,255,255,0.07)";

interface PressureCellProps {
    /** Active trading pair in slash form, e.g. "BTC/USD". */
    pair: string;
}

export function PressureCell({ pair }: PressureCellProps) {
    // Canonical slash-free uppercase form — matches the aggregator's
    // KNOWN_PAIRS. canonicalPair() on the backend accepts either form, but
    // normalizing here keeps the URL clean.
    const canonical = pair.replace(/\//g, "").toUpperCase();

    const [snapshot, setSnapshot] = useState<PressureSnapshot | null>(null);
    const [stale, setStale] = useState(false);

    useEffect(() => {
        // New pair ⇒ back to the loading state until the first event lands.
        setSnapshot(null);
        setStale(false);

        let closed = false;
        let es: EventSource | null = null;
        let reconnectAttempt = 0;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let staleTimer: ReturnType<typeof setTimeout> | null = null;

        const armStaleTimer = () => {
            if (staleTimer) clearTimeout(staleTimer);
            staleTimer = setTimeout(() => setStale(true), STALE_TIMEOUT_MS);
        };

        const connect = () => {
            if (closed) return;
            es = new EventSource(
                `${API_BASE}/v1/market/pressure/stream?pair=${canonical}`,
            );

            es.addEventListener("pressure", (e) => {
                // A delivered event means the connection is healthy — reset
                // the backoff so the next disconnect restarts from 1s.
                reconnectAttempt = 0;
                try {
                    const snap = JSON.parse((e as MessageEvent<string>).data) as PressureSnapshot;
                    setSnapshot(snap);
                    setStale(snap.stale);
                } catch {
                    // Malformed payload — ignore, keep the last good snapshot.
                }
                armStaleTimer();
            });

            es.onerror = () => {
                // Native EventSource retries on a fixed interval; close it and
                // drive our own exponential backoff instead.
                es?.close();
                es = null;
                if (closed) return;
                const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)]!;
                reconnectAttempt++;
                reconnectTimer = setTimeout(connect, delay);
            };
        };

        connect();

        // Close the stream and clear every timer on unmount / pair change.
        return () => {
            closed = true;
            es?.close();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (staleTimer) clearTimeout(staleTimer);
        };
    }, [canonical]);

    // Live = first event received AND not stale. Loading and stale share the
    // same muted treatment — the fade IS the signal, no badge.
    const live = snapshot !== null && !stale;
    const buyPct = snapshot?.buyPct ?? 50;
    const sellPct = snapshot?.sellPct ?? 50;

    const buyColor = live ? "var(--g, #00ff41)" : MUTED_TEXT;
    const sellColor = live ? "var(--red, #ff3b3b)" : MUTED_TEXT;
    const buyBar = live ? "var(--g, #00ff41)" : MUTED_BAR;
    const sellBar = live ? "var(--red, #ff3b3b)" : MUTED_BAR;
    const pctColor = live ? "rgba(255,255,255,0.7)" : MUTED_TEXT;

    const pctText = (n: number) => (snapshot === null ? "—%" : `${n}%`);

    const labelStyle = (color: string): CSSProperties => ({
        fontSize: 8,
        letterSpacing: 2,
        color,
        transition: "color 0.3s",
    });
    // Fixed-width, tabular-figure pct spans — keeps Cell 4 width stable
    // across "—%", "73%", "100%" so no layout shift on every SSE update.
    const pctStyle = (textAlign: "left" | "right"): CSSProperties => ({
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        color: pctColor,
        minWidth: 26,
        textAlign,
        transition: "color 0.3s",
    });

    return (
        <div
            className="tr-cr-pressure"
            style={{ gap: 5, whiteSpace: "nowrap" }}
            title="Aggressor buy/sell pressure — rolling 5-minute window"
        >
            <span style={labelStyle(buyColor)}>BUY</span>
            <span style={pctStyle("right")}>{pctText(buyPct)}</span>
            <span
                style={{
                    display: "inline-flex",
                    width: 54,
                    height: 5,
                    borderRadius: 2,
                    overflow: "hidden",
                    background: BAR_TRACK,
                }}
            >
                <span style={{ width: `${buyPct}%`, background: buyBar, transition: "width 0.3s, background-color 0.3s" }} />
                <span style={{ width: `${sellPct}%`, background: sellBar, transition: "width 0.3s, background-color 0.3s" }} />
            </span>
            <span style={pctStyle("left")}>{pctText(sellPct)}</span>
            <span style={labelStyle(sellColor)}>SELL</span>
        </div>
    );
}
