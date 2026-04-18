import { useState, useEffect, useCallback, useRef } from "react";
import Decimal from "decimal.js-light";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";
import { useTradingStore } from "@/stores/tradingStore";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import { getPositions } from "@/api/endpoints/analytics";
import { forfeitMatch, getActiveMatch, getMatch, type Match } from "@/api/endpoints/matches";
import { MatchHeaderBar } from "./MatchHeaderBar";
import { MatchEndOverlay } from "./MatchEndOverlay";
import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import type { Position } from "@/types/api";

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
  .lmv-order-section {
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
    border-top: 1px solid var(--ar-borderW);
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

    const [match, setMatch] = useState(initialMatch);
    const [positions, setPositions] = useState<Position[]>([]);
    const [showEndOverlay, setShowEndOverlay] = useState(false);

    // Tracks whether the component is still mounted, so async SSE handlers
    // and polls don't setState on an unmounted component.
    const isMounted = useRef(true);
    useEffect(() => {
        return () => {
            isMounted.current = false;
        };
    }, []);

    const isChallenger = match.challenger_id === userId;
    const yourName = isChallenger ? (match.challenger_name ?? "YOU") : (match.opponent_name ?? "YOU");
    const opponentName = isChallenger ? (match.opponent_name ?? "OPPONENT") : (match.challenger_name ?? "OPPONENT");
    const yourPnl = isChallenger ? match.challenger_pnl_pct : match.opponent_pnl_pct;
    const opponentPnl = isChallenger ? match.opponent_pnl_pct : match.challenger_pnl_pct;

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

    // Poll match state every 15s
    useEffect(() => {
        const poll = async () => {
            try {
                const { data } = await getActiveMatch();
                if (data.match) {
                    setMatch(data.match);
                    if (data.match.status === "COMPLETED" || data.match.status === "FORFEITED") {
                        setShowEndOverlay(true);
                    }
                } else {
                    // No active match — fetch final state by ID for accurate result display
                    try {
                        const { data: full } = await getMatch(match.id);
                        setMatch(full.match);
                    } catch { /* ignore — overlay will use existing match state */ }
                    setShowEndOverlay(true);
                }
            } catch { /* ignore */ }
        };
        const id = setInterval(poll, 15_000);
        return () => clearInterval(id);
    }, [match.id]);

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
        } catch { /* ignore */ }
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
            />

            {/* FULL WIDTH TRADING VIEW */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", flex: 1, minHeight: 0, overflow: "hidden" }}>
                {/* CHART — full height left column */}
                <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", height: "100%", minHeight: 0 }}>
                    <CandlestickChart />
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
