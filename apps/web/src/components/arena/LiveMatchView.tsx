import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import { chartLiqPrice } from "@/lib/leverageUi";
import type { Timeframe } from "@/api/endpoints/candles";
import { getPositions } from "@/api/endpoints/analytics";
import type { Match } from "@/api/endpoints/matches";
import { useActiveMatchStore, useMatchPnl } from "@/stores/activeMatchStore";
import { MatchHeaderBar } from "./MatchHeaderBar";
import { MatchEndOverlay } from "./MatchEndOverlay";
import { MatchChatPanel } from "./MatchChatPanel";
import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import { useToast } from "@/components/ToastProvider";
import type { Position, MessageReceivedEvent } from "@/types/api";
import Spinner from "@/components/Spinner";
import { pickInitialPairId } from "@/lib/pairs";

/* ─────────────────────────────────────────
   LIVE MATCH VIEW CSS
───────────────────────────────────────── */
const LMV_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  .lmv-wrap, .lmv-wrap *, .lmv-wrap *::before, .lmv-wrap *::after {
    box-sizing: border-box;
  }

  .lmv-wrap {
    --ar-g: #00ff41; --ar-red: #ff3b3b; --ar-orange: #FF6B00;
    --ar-gold: #FFD700; --ar-bg: #040404; --ar-bg2: #080808;
    --ar-border: rgba(255,107,0,0.16); --ar-borderW: rgba(255,255,255,0.06);
    --ar-muted: rgba(255,255,255,0.3); --ar-faint: rgba(255,255,255,0.05);
    --ar-bebas: 'Bebas Neue', sans-serif; --ar-mono: 'Space Mono', monospace;
    font-family: var(--ar-mono);
    color: rgba(255,255,255,0.88);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  /* ── SPLIT AREA ── */
  .lmv-split {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .lmv-side {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .lmv-side.opponent {
    background: rgba(204,0,0,0.03);
  }
  .lmv-divider {
    width: 2px;
    background: var(--ar-orange);
    flex-shrink: 0;
  }

  /* ── CHART CONTAINER ── */
  .lmv-chart-wrap {
    flex: 1;
    min-height: 200px;
    position: relative;
    overflow: hidden;
  }
  .lmv-chart-wrap.readonly {
    pointer-events: none;
  }
  .lmv-opp-label {
    position: absolute;
    top: 8px;
    left: 12px;
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 3px;
    color: rgba(255,255,255,0.4);
    z-index: 10;
    pointer-events: none;
  }

  /* ── STATS ROW ── */
  .lmv-stats {
    height: 48px;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 0 16px;
    border-top: 1px solid var(--ar-borderW);
    border-bottom: 1px solid var(--ar-borderW);
    font-size: 11px;
  }
  .lmv-stat-lbl {
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-right: 6px;
  }
  .lmv-stat-val {
    font-family: var(--ar-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
  }

  /* ── ORDER PANEL (reuse TradingPage styles) ── */
  /* No overflow here: the panel scrolls via its outer flex:1 wrapper. Keeping
     overflow-y on this content-height element would make it the sticky
     scroll-ancestor of the position card and leave the card unable to pin. */
  .lmv-order-section {
    min-height: 0;
    padding: 12px 16px;
    border-top: 1px solid var(--ar-borderW);
  }

  /* UnifiedOrderPanel's summary+submit footer wrapper. The arena keeps the
     original flow layout, so render it layout-transparent (the sticky-footer
     behavior is trade-page-only — see .tr-order-footer-pinned). */
  .lmv-order-footer { display: contents; }

  /* sticky position card — pins to the bottom of the scrollable order panel
     area so an open position stays visible regardless of scroll. Mirrors
     .tr-position-card-sticky on the trading page; background matches the
     arena base (--ar-bg) so form content scrolling behind is covered. */
  .lmv-position-card-sticky {
    position: sticky;
    bottom: 0;
    z-index: 2;
    margin: 12px -16px 0;
    padding: 12px 16px;
    background: #040404;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  /* Position open: summary + submit in normal flow, the card at the top of
     the panel (see .tr-order-footer-with-position): pinned, the group hid the
     form above it. */
  .lmv-order-footer-with-position {
    display: block;
    position: static;
    margin: 0 -16px;
    padding: 8px 16px 0;
    background: #040404;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  /* CLOSE and the confirms, pinned (see .tr-pos-actions). */
  .lmv-pos-actions {
    position: sticky;
    bottom: 0;
    z-index: 3;
    margin: 8px -16px -12px;
    padding: 8px 16px 12px;
    background: #040404;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  /* The card at the top of the panel, above LONG/SHORT (see the trade page's
     .tr-order-section > .tr-position-card-sticky). */
  .lmv-order-section > .lmv-position-card-sticky {
    position: static;
    margin: -12px -16px 12px;
    border-top: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  /* Phone: the card's equity / "reverse to …" row stacks left-aligned, clear
     of the fixed Agent Activity button (see .tr-pos-foot). */
  @media (max-width: 768px) {
    .lmv-pos-foot { flex-direction: column !important; align-items: flex-start !important; }
  }

  /* Order form inline styles */
  .lmv-dir-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 8px;
  }
  .lmv-dir-btn {
    flex: 1;
    text-align: center;
    padding: 8px;
    font-family: var(--ar-mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 3px;
    cursor: pointer;
    border: 1px solid var(--ar-borderW);
    background: transparent;
    color: rgba(255,255,255,0.4);
    transition: all 0.15s;
  }
  .lmv-dir-btn.long.active {
    color: var(--ar-g);
    border-color: var(--ar-g);
    background: rgba(0,255,65,0.06);
  }
  .lmv-dir-btn.short.active {
    color: var(--ar-red);
    border-color: var(--ar-red);
    background: rgba(255,59,59,0.06);
  }
  .lmv-type-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 8px;
  }
  .lmv-tt {
    flex: 1;
    text-align: center;
    padding: 6px;
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--ar-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
  }
  .lmv-tt.active {
    color: var(--ar-orange);
    border-bottom-color: var(--ar-orange);
  }
  .lmv-field {
    margin-bottom: 8px;
  }
  .lmv-field label {
    display: block;
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-bottom: 4px;
  }
  .lmv-field-wrap {
    display: flex;
    align-items: center;
    border: 1px solid var(--ar-borderW);
    background: rgba(255,255,255,0.03);
  }
  .lmv-field-wrap input {
    flex: 1;
    background: transparent;
    border: none;
    color: #fff;
    font-family: var(--ar-mono);
    font-size: 12px;
    padding: 8px 10px;
    outline: none;
    width: 0;
  }
  .lmv-field-unit {
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--ar-muted);
    padding-right: 10px;
    flex-shrink: 0;
  }
  .lmv-pct-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .lmv-pct {
    flex: 1;
    text-align: center;
    padding: 4px;
    font-size: 9px;
    letter-spacing: 1px;
    color: var(--ar-muted);
    border: 1px solid var(--ar-borderW);
    cursor: pointer;
    transition: all 0.15s;
  }
  .lmv-pct.active, .lmv-pct:hover {
    color: var(--ar-orange);
    border-color: var(--ar-orange);
    background: rgba(255,107,0,0.06);
  }
  .lmv-summary {
    margin-bottom: 8px;
  }
  .lmv-sum-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    padding: 2px 0;
  }
  .lmv-sum-lbl { color: var(--ar-muted); }
  .lmv-sum-val { color: rgba(255,255,255,0.7); }
  /* Empty POSITION SIZE / FEE dash dims to 0.2 — matching this card's own
     already-muted TP/SL dashes — so all four empty states read consistently
     as intentionally empty rather than missing data. */
  .lmv-sum-empty { color: rgba(255,255,255,0.2); }
  .lmv-place-btn {
    width: 100%;
    padding: 10px;
    font-family: var(--ar-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 3px;
    border: none;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .lmv-place-btn.buy {
    background: var(--ar-g);
    color: #000;
  }
  .lmv-place-btn.sell {
    background: var(--ar-red);
    color: #fff;
  }
  .lmv-place-btn.success {
    background: var(--ar-g);
    color: #000;
  }
  .lmv-place-btn.error {
    background: var(--ar-red);
    color: #fff;
  }
  .lmv-place-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .lmv-close-btn {
    width: 100%;
    padding: 8px;
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--ar-red);
    border: 1px solid rgba(255,59,59,0.3);
    background: rgba(255,59,59,0.06);
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .lmv-close-btn:hover { background: rgba(255,59,59,0.12); }
  .lmv-close-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .lmv-balance-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--ar-borderW);
  }
  .lmv-bal-lbl { color: var(--ar-muted); letter-spacing: 2px; font-size: 8px; }
  .lmv-bal-val { color: #fff; font-weight: 700; }

  /* ── OPPONENT FEED ── */
  .lmv-opp-feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
    border-top: 1px solid var(--ar-borderW);
  }
  .lmv-feed-label {
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-bottom: 8px;
  }
  .lmv-feed-empty {
    font-size: 11px;
    color: rgba(255,255,255,0.2);
    text-align: center;
    padding: 32px 16px;
    line-height: 1.6;
  }
  .lmv-feed-list { display: flex; flex-direction: column; gap: 4px; }
  .lmv-feed-entry {
    display: flex;
    gap: 8px;
    font-size: 10px;
    padding: 4px 0;
    animation: lmv-fadeIn 0.3s ease-out;
  }
  @keyframes lmv-fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .lmv-feed-ts { color: var(--ar-muted); font-size: 9px; flex-shrink: 0; }
  .lmv-feed-action { color: rgba(255,255,255,0.6); }

`;

/* ── MatchOrderPanel removed — see UnifiedOrderPanel.tsx ── */

/* ─────────────────────────────────────────
   MAIN LIVE MATCH VIEW
───────────────────────────────────────── */
interface LiveMatchViewProps {
    match: Match;
    onMatchEnd: () => void;
}

export function LiveMatchView({ match: initialMatch, onMatchEnd }: LiveMatchViewProps) {
    const userId = useAuthStore((s) => s.user?.id) ?? "";
    const pairs = useAppStore((s) => s.pairs);
    const pairsLoaded = useAppStore((s) => s.pairsLoaded);
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const selectPair = useTradingStore((s) => s.selectPair);
    const { addToast } = useToast();

    // The session lives in activeMatchStore. The prop only covers the moment
    // before the store has loaded the match ArenaPage already has.
    const storeMatch = useActiveMatchStore((s) => s.activeMatch);
    const endedMatch = useActiveMatchStore((s) => s.endedMatch);
    const settling = useActiveMatchStore((s) => s.settling);
    const forfeit = useActiveMatchStore((s) => s.forfeit);
    const dismissEndedMatch = useActiveMatchStore((s) => s.dismissEndedMatch);
    const setTradeMode = useActiveMatchStore((s) => s.setTradeMode);
    const match = endedMatch?.id === initialMatch.id
        ? endedMatch
        : storeMatch?.status === "ACTIVE" ? storeMatch : initialMatch;
    const [positions, setPositions] = useState<Position[]>([]);

    // Match Chat — ephemeral, component-local (no store). The panel itself
    // owns the message log; this view only tracks open/closed + the unread
    // badge shown on MatchHeaderBar's toggle. Mounted lazily on first open
    // (chatEverOpened) and then kept mounted so the log survives further
    // toggles instead of refetching every time.
    const [chatOpen, setChatOpen] = useState(false);
    const [chatEverOpened, setChatEverOpened] = useState(false);
    const [chatUnread, setChatUnread] = useState(0);
    const handleToggleChat = useCallback(() => {
        setChatOpen((open) => {
            const next = !open;
            if (next) {
                setChatUnread(0);
                setChatEverOpened(true);
            }
            return next;
        });
    }, []);
    // LiveMatchView isn't remounted between matches (ArenaPage renders it
    // keyless), so a new match.id must explicitly reset chat state. Without
    // this, a leftover chatEverOpened would mount a fresh match's panel straight onto whatever
    // open/unread state the previous match's chat left behind.
    useEffect(() => {
        setChatOpen(false);
        setChatEverOpened(false);
        setChatUnread(0);
    }, [match.id]);
    // This view has no timeframe/indicator toolbar of its own — these just
    // replicate CandlestickChart's old uncontrolled defaults ("1h" / "visible")
    // now that timeframe/vpvrMode are controlled props. Not state — nothing
    // in this view changes them.
    const timeframe: Timeframe = "1h";
    const vpvrMode = "visible" as const;

    // Tracks whether the component is still mounted, so async handlers don't
    // setState on an unmounted component. Must set true on mount, not just
    // false in cleanup: React StrictMode's dev-only double-invoke runs the
    // cleanup once before the "real" mount.
    const isMounted = useRef(true);
    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    const isChallenger = match.challenger_id === userId;
    const yourName = isChallenger ? (match.challenger_name ?? "YOU") : (match.opponent_name ?? "YOU");
    const opponentName = isChallenger ? (match.opponent_name ?? "OPPONENT") : (match.challenger_name ?? "OPPONENT");

    const { challengerPnlPct, opponentPnlPct } = useMatchPnl(match);
    const yourPnl = isChallenger ? challengerPnlPct : opponentPnlPct;
    const opponentPnl = isChallenger ? opponentPnlPct : challengerPnlPct;

    // Default on mount: the user's last pick if it's still offered, else
    // BTC/USD (pickInitialPairId in lib/pairs).
    useEffect(() => {
        if (!selectedPairId && pairs.length > 0) {
            const initial = pickInitialPairId(pairs);
            if (initial) selectPair(initial);
        }
    }, [selectedPairId, pairs, selectPair]);

    // Inject CSS
    useEffect(() => {
        const id = "lmv-css";
        if (!document.getElementById(id)) {
            const s = document.createElement("style");
            s.id = id;
            s.textContent = LMV_CSS;
            document.head.appendChild(s);
        }
    }, []);

    // Match Chat unread badge — MessageReceivedEvent never carries matchId,
    // so (per the approved Gate 0 constraint) a "match" conversationType push
    // arriving while this view is mounted is attributed to the current match
    // via the one-active-match invariant. Only bumps while the panel is
    // closed; MatchChatPanel handles its own log while open.
    useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MessageReceivedEvent>).detail;
            if (!d || d.conversationType !== "match" || !isMounted.current) return;
            if (!chatOpen) setChatUnread((n) => n + 1);
        };
        window.addEventListener("sse:message.received", handler);
        return () => window.removeEventListener("sse:message.received", handler);
    }, [chatOpen]);

    // Fetch positions
    const refreshPositions = useCallback(() => {
        getPositions({ scope: match.id })
            .then((res) => {
                if (isMounted.current) setPositions(res.data.positions);
            })
            .catch(() => {});
    }, [match.id]);

    // This view is always the match. PRACTICE lives on /trade.
    useEffect(() => {
        setTradeMode("MATCH");
    }, [setTradeMode]);

    useEffect(() => {
        refreshPositions();
    }, [selectedPairId, refreshPositions]);

    useEffect(() => {
        const handler = () => {
            if (isMounted.current) refreshPositions();
        };
        window.addEventListener("sse:trade.created", handler);
        window.addEventListener("sse:position.liquidated", handler);
        return () => {
            window.removeEventListener("sse:trade.created", handler);
            window.removeEventListener("sse:position.liquidated", handler);
        };
    }, [refreshPositions]);

    // Handle forfeit
    const handleForfeit = async () => {
        try {
            await forfeit(match.id);
        } catch (err: any) {
            const msg = err?.response?.data?.message;
            addToast("error", msg ?? "Couldn't forfeit the match. Try again.");
        }
    };

    // Derived data
    const selectedPair = pairs.find((p) => p.id === selectedPairId);
    const currentPosition = positions.find((p) => p.pair_id === selectedPairId) ?? null;

    if (!selectedPair) {
        // Show the empty state only once GET /pairs has succeeded and come back
        // empty; until then (or during the tick before the select-first-pair
        // effect runs) show a spinner. ArenaPage renders this view directly with
        // no pairs gate of its own, so the guard has to live here.
        const pairsGenuinelyEmpty = pairsLoaded && pairs.length === 0;
        return (
            <div className="lmv-wrap" style={{ alignItems: "center", justifyContent: "center", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                {pairsGenuinelyEmpty ? "NO PAIRS AVAILABLE" : <Spinner size="md" />}
            </div>
        );
    }

    return (
        <div className="lmv-wrap">
            {/* COMPACT OPPONENT BAR */}
            <MatchHeaderBar
                match={match}
                yourPnl={yourPnl}
                opponentPnl={opponentPnl}
                yourName={yourName}
                opponentName={opponentName}
                onForfeit={handleForfeit}
                chatOpen={chatOpen}
                chatUnread={chatUnread}
                onToggleChat={handleToggleChat}
                settling={settling && match.id === storeMatch?.id}
            />

            {/* FULL WIDTH TRADING VIEW */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", flex: 1, minHeight: 0, overflow: "hidden" }}>
                {/* CHART — full height left column */}
                <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", height: "100%", minHeight: 0 }}>
                    <CandlestickChart timeframe={timeframe} vpvrMode={vpvrMode} liquidationPrice={chartLiqPrice(currentPosition)} />
                </div>

                {/* RIGHT COLUMN — order panel */}
                <div style={{ display: "flex", flexDirection: "column", height: "100%", maxHeight: "100%", overflow: "hidden", borderLeft: "1px solid var(--ar-orange)" }}>
                    <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                        <UnifiedOrderPanel
                            pair={selectedPair}
                            position={currentPosition}
                            positions={positions}
                            onOrderFilled={refreshPositions}
                            classPrefix="lmv"
                        />
                    </div>
                </div>
            </div>

            {/* MATCH CHAT — floating panel, lazily mounted on first open then
                kept mounted (visibility toggled via CSS) so the log persists */}
            {chatEverOpened && (
                <MatchChatPanel
                    matchId={match.id}
                    opponentName={opponentName}
                    isOpen={chatOpen}
                    onClose={() => setChatOpen(false)}
                />
            )}

            {/* MATCH END OVERLAY */}
            {endedMatch?.id === match.id && (
                <MatchEndOverlay
                    match={endedMatch}
                    userId={userId}
                    onBackToArena={() => {
                        dismissEndedMatch();
                        onMatchEnd();
                    }}
                />
            )}
        </div>
    );
}
