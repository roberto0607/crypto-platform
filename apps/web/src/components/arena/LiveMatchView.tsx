import { useState, useEffect, useCallback, useRef } from "react";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import type { Timeframe } from "@/api/endpoints/candles";
import { getPositions } from "@/api/endpoints/analytics";
import { forfeitMatch, getActiveMatch, getMatch, type Match } from "@/api/endpoints/matches";
import { MatchHeaderBar } from "./MatchHeaderBar";
import { MatchEndOverlay } from "./MatchEndOverlay";
import { MatchChatPanel } from "./MatchChatPanel";
import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import { useToast } from "@/components/ToastProvider";
import type { Position, MatchEndedEvent, MatchPnlUpdateEvent, MessageReceivedEvent } from "@/types/api";

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

  /* ── HEADER BAR ── */
  .lmv-header {
    height: 56px;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    background: var(--ar-bg2);
    border-bottom: 1px solid var(--ar-orange);
    gap: 16px;
  }
  .lmv-h-left, .lmv-h-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
  }
  .lmv-h-right { justify-content: flex-end; }
  .lmv-h-center {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .lmv-h-name {
    font-family: var(--ar-mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 2px;
  }
  .lmv-h-pnl {
    font-family: var(--ar-bebas);
    font-size: 22px;
    letter-spacing: 2px;
    padding: 2px 10px;
  }
  .lmv-h-vs {
    font-family: var(--ar-bebas);
    font-size: 20px;
    color: var(--ar-orange);
    opacity: 0.6;
    letter-spacing: 3px;
  }
  .lmv-h-badge {
    font-family: var(--ar-mono);
    font-size: 9px;
    letter-spacing: 3px;
    color: var(--ar-orange);
    border: 1px solid var(--ar-orange);
    padding: 3px 8px;
    animation: lmv-pulse 2s ease-in-out infinite;
  }
  @keyframes lmv-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .lmv-h-timer {
    font-family: var(--ar-mono);
    font-size: 13px;
    letter-spacing: 2px;
    color: rgba(255,255,255,0.6);
  }
  .lmv-h-timer.urgent {
    color: var(--ar-red);
    animation: lmv-pulse 1s ease-in-out infinite;
  }
  .lmv-forfeit-btn {
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--ar-red);
    border: 1px solid var(--ar-red);
    background: transparent;
    padding: 4px 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .lmv-forfeit-btn:hover {
    background: rgba(255,59,59,0.1);
  }
  .lmv-chat-toggle {
    position: relative;
    font-family: var(--ar-mono);
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255,255,255,0.6);
    border: 1px solid var(--ar-borderW);
    background: transparent;
    padding: 4px 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .lmv-chat-toggle:hover {
    border-color: var(--ar-orange);
    color: var(--ar-orange);
  }
  .lmv-chat-toggle.active {
    border-color: var(--ar-orange);
    color: var(--ar-orange);
    background: rgba(255,107,0,0.06);
  }
  .lmv-chat-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    background: var(--ar-red);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    border-radius: 50%;
    min-width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 3px;
  }

  /* ── MODAL ── */
  .lmv-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .lmv-modal {
    background: #0c0c0c;
    border: 1px solid var(--ar-orange);
    padding: 32px;
    max-width: 420px;
    width: 90%;
  }
  .lmv-modal-title {
    font-family: var(--ar-bebas);
    font-size: 28px;
    letter-spacing: 4px;
    color: var(--ar-red);
    margin-bottom: 12px;
  }
  .lmv-modal-text {
    font-size: 11px;
    line-height: 1.6;
    color: rgba(255,255,255,0.6);
    margin-bottom: 24px;
  }
  .lmv-modal-actions {
    display: flex;
    gap: 12px;
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

  /* ── MATCH END OVERLAY ── */
  .lmv-end-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .lmv-end-card {
    text-align: center;
    padding: 48px 64px;
    border: 1px solid var(--ar-orange);
    background: #0a0a0a;
    min-width: 340px;
  }
  .lmv-end-result {
    font-family: var(--ar-bebas);
    font-size: 48px;
    letter-spacing: 6px;
    margin-bottom: 24px;
  }
  .lmv-end-pnl-row {
    display: flex;
    justify-content: center;
    gap: 40px;
    margin-bottom: 24px;
  }
  .lmv-end-label {
    font-size: 8px;
    letter-spacing: 3px;
    color: var(--ar-muted);
    margin-bottom: 4px;
  }
  .lmv-end-val {
    font-family: var(--ar-bebas);
    font-size: 28px;
    letter-spacing: 2px;
  }
  .lmv-end-elo-section {
    display: flex;
    justify-content: center;
    gap: 40px;
    margin-bottom: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--ar-borderW);
  }
  .lmv-end-actions {
    display: flex;
    justify-content: center;
    gap: 12px;
  }

  /* ── MATCH CHAT PANEL ── */
  /* Floating over .lmv-wrap (position:relative below), kept mounted after
     first open so the log survives toggling closed/open — only visibility
     animates, not mount state. */
  .lmv-chat-panel {
    position: absolute;
    right: 16px;
    bottom: 16px;
    width: 300px;
    height: 380px;
    max-height: calc(100% - 32px);
    background: var(--ar-bg2);
    border: 1px solid var(--ar-orange);
    display: flex;
    flex-direction: column;
    z-index: 500;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    opacity: 0;
    visibility: hidden;
    transform: translateY(12px);
    transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
    pointer-events: none;
  }
  .lmv-chat-panel.open {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
    pointer-events: auto;
  }
  .lmv-chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--ar-borderW);
    flex-shrink: 0;
  }
  .lmv-chat-title {
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--ar-orange);
  }
  .lmv-chat-close {
    background: transparent;
    border: none;
    color: rgba(255,255,255,0.5);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .lmv-chat-close:hover { color: #fff; }
  .lmv-chat-log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column-reverse;
    gap: 6px;
    padding: 10px 12px;
  }
  .lmv-chat-empty {
    margin: auto;
    font-size: 10px;
    color: rgba(255,255,255,0.2);
    text-align: center;
  }
  .lmv-chat-msg {
    display: flex;
    flex-direction: column;
    max-width: 85%;
  }
  .lmv-chat-msg.mine { align-self: flex-end; align-items: flex-end; }
  .lmv-chat-msg:not(.mine) { align-self: flex-start; align-items: flex-start; }
  .lmv-chat-bubble {
    font-size: 11px;
    line-height: 1.4;
    padding: 6px 10px;
    background: rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.85);
    word-break: break-word;
  }
  .lmv-chat-msg.mine .lmv-chat-bubble {
    background: rgba(255,107,0,0.12);
    color: #fff;
  }
  .lmv-chat-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .lmv-chat-ts {
    font-size: 8px;
    color: var(--ar-muted);
  }
  .lmv-chat-report {
    font-family: var(--ar-mono);
    font-size: 8px;
    letter-spacing: 1px;
    color: var(--ar-muted);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .lmv-chat-report:hover {
    color: var(--ar-red);
    text-decoration: underline;
  }
  .lmv-chat-reported {
    font-size: 8px;
    letter-spacing: 1px;
    color: rgba(255,255,255,0.15);
  }
  .lmv-chat-error {
    font-size: 9px;
    color: var(--ar-red);
    padding: 0 12px 4px;
  }
  .lmv-chat-input-row {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid var(--ar-borderW);
    flex-shrink: 0;
  }
  .lmv-chat-input {
    flex: 1;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--ar-borderW);
    color: #fff;
    font-family: var(--ar-mono);
    font-size: 11px;
    padding: 6px 8px;
    outline: none;
    min-width: 0;
  }
  .lmv-chat-input:focus { border-color: var(--ar-orange); }
  .lmv-chat-send {
    font-family: var(--ar-mono);
    font-size: 9px;
    letter-spacing: 1px;
    color: var(--ar-orange);
    border: 1px solid var(--ar-orange);
    background: transparent;
    padding: 0 10px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .lmv-chat-send:hover:not(:disabled) { background: rgba(255,107,0,0.1); }
  .lmv-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
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
    const wallets = useAppStore((s) => s.wallets);
    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const selectPair = useTradingStore((s) => s.selectPair);
    const { addToast } = useToast();

    const [match, setMatch] = useState(initialMatch);
    const [positions, setPositions] = useState<Position[]>([]);
    const [showEndOverlay, setShowEndOverlay] = useState(false);

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
    // keyless), so a new match.id must explicitly reset chat state — same
    // reason livePnl resets on match.id below. Without this, a leftover
    // chatEverOpened would mount a fresh match's panel straight onto whatever
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

    // Tracks whether the component is still mounted, so async SSE handlers
    // and polls don't setState on an unmounted component. Must set true on
    // mount, not just false in cleanup -- React StrictMode's dev-only
    // mount/unmount/remount double-invoke runs this effect's cleanup once
    // before the "real" mount, which without the explicit reset left
    // isMounted.current permanently false for the rest of the session
    // (silently no-oping every isMounted-gated handler below, including
    // match.ended's fast path). Dev-only; production doesn't double-invoke.
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

    // Live in-match PnL — kept as separate state from `match`, NOT patched
    // into it, because syncMatchState's 30s safety-net poll (and the
    // reconnect refetch) call setMatch(data.match) wholesale from the
    // stale DB row snapshot every cycle; patching pnl fields directly into
    // `match` would get clobbered back to 0.00% on the very next poll.
    // Falls back to the row snapshot until the first qualifying push
    // arrives; reset on match change so a stale number can't leak.
    const [livePnl, setLivePnl] = useState<{ challengerPnlPct: string; opponentPnlPct: string } | null>(null);
    useEffect(() => {
        setLivePnl(null);
    }, [match.id]);

    const challengerPnlPct = livePnl?.challengerPnlPct ?? match.challenger_pnl_pct;
    const opponentPnlPct = livePnl?.opponentPnlPct ?? match.opponent_pnl_pct;
    const yourPnl = isChallenger ? challengerPnlPct : opponentPnlPct;
    const opponentPnl = isChallenger ? opponentPnlPct : challengerPnlPct;

    // Default to first active pair on mount
    useEffect(() => {
        if (!selectedPairId && pairs.length > 0) {
            selectPair(pairs[0]!.id);
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

    // Re-fetch authoritative match state from the server. Shared by the slow
    // poll safety net and the reconnect refetch. The `match.ended` SSE push is
    // the fast path (sub-second); this only catches a push that never arrived.
    const syncMatchState = useCallback(async () => {
        try {
            const { data } = await getActiveMatch();
            if (!isMounted.current) return;
            if (data.match) {
                setMatch(data.match);
                if (data.match.status === "COMPLETED" || data.match.status === "FORFEITED") {
                    setLivePnl(null);
                    setShowEndOverlay(true);
                }
            } else {
                // No active match — fetch final state by ID for accurate result display
                try {
                    const { data: full } = await getMatch(match.id);
                    if (isMounted.current) setMatch(full.match);
                } catch { /* ignore — overlay will use existing match state */ }
                if (isMounted.current) {
                    setLivePnl(null);
                    setShowEndOverlay(true);
                }
            }
        } catch { /* ignore */ }
    }, [match.id]);

    // Fast path: the opponent's verdict arrives via the `match.ended` SSE push.
    // Patch the terminal fields from the payload and flip the overlay — no
    // re-fetch needed for the verdict (the overlay's own GET /result call
    // enriches the ELO count-up afterward). This is what makes the WON/LOST
    // screen appear instantly instead of on the next poll tick.
    useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MatchEndedEvent>).detail;
            if (!d || d.matchId !== match.id || !isMounted.current) return;
            setMatch((prev) => ({
                ...prev,
                status: d.reason === "timeout" ? "COMPLETED" : "FORFEITED",
                winner_id: d.winnerUserId,
                forfeit_user_id: d.forfeitUserId,
                challenger_pnl_pct: d.challengerPnlPct,
                opponent_pnl_pct: d.opponentPnlPct,
                elo_delta: d.eloDeltas?.winner ?? prev.elo_delta,
            }));
            // Clear the live push so these authoritative terminal values (not
            // a slightly-earlier live number) win via the livePnl ?? match.*
            // fallback above.
            setLivePnl(null);
            setShowEndOverlay(true);
        };
        window.addEventListener("sse:match.ended", handler);
        return () => window.removeEventListener("sse:match.ended", handler);
    }, [match.id]);

    // Live in-match PnL — patches the separate livePnl state (see above)
    // from the match.pnl.update SSE push instead of the frozen row
    // snapshot, so yourPnl/opponentPnl track price in real time.
    useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent<MatchPnlUpdateEvent>).detail;
            if (!d || d.matchId !== match.id || !isMounted.current) return;
            setLivePnl({ challengerPnlPct: d.challengerPnlPct, opponentPnlPct: d.opponentPnlPct });
        };
        window.addEventListener("sse:match.pnl.update", handler);
        return () => window.removeEventListener("sse:match.pnl.update", handler);
    }, [match.id]);

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

    // Safety net: poll every 30s in case a push was missed (slowed from 15s now
    // that the SSE push is the primary signal).
    useEffect(() => {
        const id = setInterval(syncMatchState, 30_000);
        return () => clearInterval(id);
    }, [syncMatchState]);

    // The eventBus has no replay buffer: a tab disconnected at the instant
    // `match.ended` fires misses it permanently. On SSE reconnect, re-sync so
    // the verdict resolves immediately rather than waiting up to 30s.
    useEffect(() => {
        const handler = () => { void syncMatchState(); };
        window.addEventListener("sse:reconnected", handler);
        return () => window.removeEventListener("sse:reconnected", handler);
    }, [syncMatchState]);

    // Check for match end by timer
    useEffect(() => {
        if (!match.ends_at) return;
        const check = () => {
            if (new Date(match.ends_at!).getTime() <= Date.now()) {
                setShowEndOverlay(true);
            }
        };
        const id = setInterval(check, 1000);
        return () => clearInterval(id);
    }, [match.ends_at]);

    // Fetch positions
    const refreshPositions = useCallback(() => {
        getPositions()
            .then((res) => {
                if (isMounted.current) setPositions(res.data.positions);
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        refreshPositions();
    }, [selectedPairId, refreshPositions]);

    useEffect(() => {
        const handler = () => {
            if (isMounted.current) refreshPositions();
        };
        window.addEventListener("sse:trade.created", handler);
        return () => window.removeEventListener("sse:trade.created", handler);
    }, [refreshPositions]);

    // Handle forfeit
    const handleForfeit = async () => {
        try {
            await forfeitMatch(match.id);
            // Fetch full match with JOINed player data (elo, names)
            const { data: full } = await getMatch(match.id);
            setMatch(full.match);
            setShowEndOverlay(true);
        } catch (err: any) {
            const msg = err?.response?.data?.message;
            addToast("error", msg ?? "Couldn't forfeit the match. Try again.");
        }
    };

    // Derived data
    const selectedPair = pairs.find((p) => p.id === selectedPairId);
    const quoteAssetId = selectedPair?.quote_asset_id;
    const quoteWallet = wallets.find((w) => w.asset_id === quoteAssetId);
    const quoteBalance = quoteWallet ? new Decimal(quoteWallet.balance).minus(quoteWallet.reserved ?? "0").toNumber() : 0;
    const currentPosition = positions.find((p) => p.pair_id === selectedPairId) ?? null;

    if (!selectedPair) {
        return <div className="lmv-wrap" style={{ alignItems: "center", justifyContent: "center", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>NO PAIRS AVAILABLE</div>;
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
            />

            {/* FULL WIDTH TRADING VIEW */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", flex: 1, minHeight: 0, overflow: "hidden" }}>
                {/* CHART — full height left column */}
                <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", height: "100%", minHeight: 0 }}>
                    <CandlestickChart timeframe={timeframe} vpvrMode={vpvrMode} />
                </div>

                {/* RIGHT COLUMN — order panel */}
                <div style={{ display: "flex", flexDirection: "column", height: "100%", maxHeight: "100%", overflow: "hidden", borderLeft: "1px solid var(--ar-orange)" }}>
                    <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                        <UnifiedOrderPanel
                            pair={selectedPair}
                            position={currentPosition}
                            quoteBalance={quoteBalance}
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
            {showEndOverlay && (
                <MatchEndOverlay
                    match={match}
                    userId={userId}
                    onBackToArena={() => {
                        setShowEndOverlay(false);
                        onMatchEnd();
                    }}
                />
            )}
        </div>
    );
}
