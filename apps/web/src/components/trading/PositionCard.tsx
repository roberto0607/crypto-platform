/**
 * The open-position card (UnifiedOrderPanel, trade page and arena).
 * Top to bottom:
 *   header   SIDE + COIN, leverage badge, how long it's been open
 *   hero     unrealized P&L ($ and %: return on margin for ISOLATED)
 *   liq      liq price + distance from the mark, margin health bar
 *            (ISOLATED only); under 25% health the card turns red and an
 *            amber box says what a liquidation leaves
 *   grid     ENTRY, MARK, SIZE, MARGIN, BREAK-EVEN, FEES PAID
 *   TP / SL  set, edit or remove a trigger on the whole position
 *   foot     equity, and "reverse to …" (the confirm and CLOSE POSITION are in
 *            the panel's pinned action bar: this card scrolls, they can't)
 * A SPOT position has no margin, liq price or health, and GET /positions
 * doesn't report its own fees, so MARGIN / BREAK-EVEN / FEES PAID hide too.
 * Every number comes from the props (the panel's one mark).
 */
import { useEffect, useState } from "react";
import type { Position, TradingPair, TriggerOrder } from "@/types/api";
import type { IsolatedPositionView } from "@/lib/leverageUi";
import type { PnlFlash } from "@/hooks/usePnlFlash";
import { healthTone } from "@/lib/leverageUi";
import { breakEvenPrice, equityAtLiq, isAtRisk, liqDistancePct, openDuration } from "@/lib/positionCard";
import { PRICE_HELP } from "@/lib/priceHelp";
import { formatPnlPct, formatPnlUsd } from "@/lib/matchPnl";

const GREEN = "#00ff41";
const RED = "#ff3b3b";
const AMBER = "#f59e0b";
const HEALTH_COLORS = { ok: GREEN, warn: AMBER, danger: RED } as const;

export function fmtUsd(n: number): string {
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export const fmtSigned = formatPnlUsd;
const fmtWholeUsd = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
export const fmtQty = (q: number) => q.toFixed(q >= 1 ? 4 : 5);

/** Ticks every 30 s so "open 3d 4h" stays current. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const smallLabel: React.CSSProperties = { color: "rgba(255,255,255,0.3)", letterSpacing: 2, fontSize: 8 };
const smallVal: React.CSSProperties = { color: "rgba(255,255,255,0.7)", fontSize: 10 };
const linkBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
};
const priceInput: React.CSSProperties = {
  width: 90, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
  color: "#fff", fontSize: 10, padding: "2px 4px", fontFamily: "inherit",
};

export interface PositionCardProps {
  classPrefix: string;
  pair: TradingPair;
  baseSymbol: string;
  position: Position;
  direction: "LONG" | "SHORT";
  /** |base_qty| and avg entry. */
  qty: number;
  entry: number;
  /** The mark the card values the position at (engine mark for ISOLATED, the ticker for SPOT). */
  mark: number;
  markStale: boolean;
  /** ISOLATED only. */
  isoView: IsolatedPositionView | null;
  health: number;
  mmrBps: number;
  pnl: number;
  pnlPct: number;
  pnlFlash: PnlFlash;
  entering: boolean;
  tpTrigger?: TriggerOrder;
  slTrigger?: TriggerOrder;
  tslTrigger?: TriggerOrder;
  /** Each resolves to an error message, or null on success. */
  onSetTrigger: (kind: "TAKE_PROFIT_MARKET" | "STOP_MARKET", price: string) => Promise<string | null>;
  onEditTrigger: (trigger: TriggerOrder, price: string) => Promise<string | null>;
  onRemoveTrigger: (trigger: TriggerOrder) => Promise<string | null>;
  reversing: boolean;
  /** Asks to reverse: the panel confirms, then sends it. */
  onReverse: () => void;
}

type TriggerKind = "TAKE_PROFIT_MARKET" | "STOP_MARKET";

export function PositionCard(props: PositionCardProps) {
  const {
    classPrefix: p, pair, baseSymbol, position, direction, qty, entry, mark, markStale, isoView,
    health, mmrBps, pnl, pnlPct, pnlFlash, entering, tpTrigger, slTrigger, tslTrigger,
  } = props;
  const now = useNow();
  const isLong = direction === "LONG";
  const sideColor = isLong ? GREEN : RED;
  const pnlColor = pnl >= 0 ? GREEN : RED;

  const openFor = openDuration(position.opened_at, now);
  const liq = isoView?.liqPrice ?? null;
  const distance = isoView ? liqDistancePct(direction, mark, liq) : null;
  const atRisk = !!isoView && isAtRisk(health, liq);
  const keep = atRisk ? equityAtLiq(qty, liq, mmrBps) : null;
  const tone = healthTone(health);

  const feesPaid = position.position_fees_paid !== undefined ? Number(position.position_fees_paid) : null;
  const breakEven = feesPaid !== null
    ? breakEvenPrice({ side: direction, qty, entry, feesPaid, takerBps: pair.taker_fee_bps })
    : null;
  const equity = isoView ? Math.max(0, isoView.margin + pnl) : qty * entry + pnl;

  // ── TP / SL: one inline price input, for setting or editing ──
  const [editing, setEditing] = useState<TriggerKind | null>(null);
  const [editVal, setEditVal] = useState("");
  const [triggerErr, setTriggerErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const triggerOf = (k: TriggerKind) => (k === "TAKE_PROFIT_MARKET" ? tpTrigger : slTrigger);
  const startEdit = (k: TriggerKind) => {
    setEditing(k);
    setEditVal(triggerOf(k)?.trigger_price ?? "");
    setTriggerErr(null);
  };
  /** A TP must be on the profit side of the mark, an SL on the loss side. */
  const sideError = (k: TriggerKind, price: number): string | null => {
    if (!(price > 0)) return "Enter a price";
    const above = price > mark;
    if (k === "TAKE_PROFIT_MARKET" && above !== isLong) return `Take profit must be ${isLong ? "above" : "below"} the mark`;
    if (k === "STOP_MARKET" && above === isLong) return `Stop loss must be ${isLong ? "below" : "above"} the mark`;
    return null;
  };
  const submitEdit = async () => {
    if (!editing) return;
    const err = sideError(editing, parseFloat(editVal));
    if (err) { setTriggerErr(err); return; }
    setBusy(true);
    const existing = triggerOf(editing);
    const res = existing ? await props.onEditTrigger(existing, editVal) : await props.onSetTrigger(editing, editVal);
    setBusy(false);
    if (res) { setTriggerErr(res); return; }
    setEditing(null);
  };
  const remove = async (t: TriggerOrder) => {
    setBusy(true);
    const res = await props.onRemoveTrigger(t);
    setBusy(false);
    setTriggerErr(res);
  };

  const triggerRow = (k: TriggerKind) => {
    const t = triggerOf(k);
    const name = k === "TAKE_PROFIT_MARKET" ? "TAKE PROFIT" : "STOP LOSS";
    const short = k === "TAKE_PROFIT_MARKET" ? "TP" : "SL";
    const color = k === "TAKE_PROFIT_MARKET" ? GREEN : RED;
    if (editing === k) {
      return (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }} data-testid={`pos-${short.toLowerCase()}-edit`}>
          <span style={smallLabel}>{short}</span>
          <input
            type="number" autoFocus aria-label={`${name} price`} value={editVal} placeholder={mark.toFixed(2)}
            onChange={(e) => { setEditVal(e.target.value); setTriggerErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void submitEdit(); if (e.key === "Escape") setEditing(null); }}
            style={priceInput}
          />
          <button type="button" disabled={busy} onClick={() => void submitEdit()} style={{ ...linkBtn, color, fontSize: 10 }}>
            {t ? "SAVE" : "SET"}
          </button>
          <button type="button" onClick={() => setEditing(null)} style={{ ...linkBtn, color: "rgba(255,255,255,0.35)", fontSize: 10 }}>
            CANCEL
          </button>
        </div>
      );
    }
    if (t) {
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10 }} data-testid={`pos-${short.toLowerCase()}`}>
          <span style={smallLabel}>{short}</span>
          <span style={{ color }}>{fmtUsd(parseFloat(t.trigger_price))}</span>
          <button type="button" aria-label={`Edit ${name.toLowerCase()}`} onClick={() => startEdit(k)}
            style={{ ...linkBtn, color: "rgba(255,255,255,0.45)", fontSize: 9 }}>EDIT</button>
          <button type="button" aria-label={`Remove ${name.toLowerCase()}`} disabled={busy} onClick={() => void remove(t)}
            style={{ ...linkBtn, color: "rgba(255,255,255,0.45)", fontSize: 9 }}>REMOVE</button>
        </div>
      );
    }
    return (
      <button type="button" onClick={() => startEdit(k)}
        style={{ ...linkBtn, color: "rgba(255,255,255,0.55)", fontSize: 9, letterSpacing: 2, textAlign: "left" }}>
        + SET {name}
      </button>
    );
  };

  const reverseTo = isLong ? "SHORT" : "LONG";

  return (
    <div className={`${p}-position-card-sticky`}>
      <div
        className={entering ? "position-card-enter" : undefined}
        data-testid="position-card"
        data-at-risk={atRisk ? "true" : undefined}
        style={{
          padding: "12px",
          border: `1px solid ${atRisk ? RED : isLong ? "rgba(0,255,65,0.2)" : "rgba(255,59,59,0.2)"}`,
          background: isLong ? "rgba(0,255,65,0.03)" : "rgba(255,59,59,0.03)",
          "--card-accent": sideColor,
        } as React.CSSProperties}
      >
        {/* ── HEADER ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: sideColor }}>
            {baseSymbol} {direction}
            {isoView && (
              <span
                data-testid="position-leverage"
                style={{ marginLeft: 6, padding: "0 4px", fontSize: 9, letterSpacing: 1, border: `1px solid ${sideColor}`, color: sideColor }}
              >
                {isoView.leverage}x
              </span>
            )}
          </span>
          {openFor && (
            <span data-testid="pos-open-for" style={{ fontSize: 9, letterSpacing: 1, color: "rgba(255,255,255,0.4)" }}
              title={`Opened ${new Date(position.opened_at!).toLocaleString()}`}>
              open {openFor}
            </span>
          )}
        </div>

        {/* ── HERO: unrealized P&L ── */}
        <div style={{ marginBottom: 10 }}>
          <span style={smallLabel}>UNREALIZED P&L</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span
              key={pnlFlash.key}
              data-testid="pos-pnl"
              className={pnlFlash.dir ? "pnl-flash" : undefined}
              style={{
                color: pnlColor, fontWeight: 700, fontSize: 22, letterSpacing: 0.5, lineHeight: 1.15,
                padding: "1px 4px", margin: "-1px -4px", borderRadius: 2,
                "--pnl-flash-tint": pnlFlash.dir === "up" ? "rgba(0,255,65,0.45)" : "rgba(255,59,59,0.45)",
              } as React.CSSProperties}
            >
              {fmtSigned(pnl)}
            </span>
            <span
              data-testid="pos-pnl-pct"
              title={isoView ? "Return on margin: unrealized P&L / margin" : "Unrealized P&L / cost"}
              style={{ color: pnlColor, fontWeight: 700, fontSize: 12 }}
            >
              {formatPnlPct(pnlPct)}{isoView && <span style={{ ...smallLabel, marginLeft: 4 }}>ROE</span>}
            </span>
          </div>
        </div>

        {/* ── LIQUIDATION + HEALTH (ISOLATED) ── */}
        {isoView && (
          <div style={{ marginBottom: 10 }} data-testid="margin-health">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 10, marginBottom: 4 }}>
              <span style={smallLabel}>LIQ PRICE</span>
              <span data-testid="pos-liq" style={{ color: liq ? AMBER : smallVal.color }}
                title={liq ? `Liquidated if the mark reaches ${fmtUsd(liq)}` : "A 1x long can't be liquidated"}>
                {liq ? fmtUsd(liq) : "None"}
                {distance !== null && (
                  <span data-testid="pos-liq-distance" style={{ color: atRisk ? RED : "rgba(255,255,255,0.45)" }}>
                    {" "}· {distance.toFixed(1)}% away
                  </span>
                )}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                role="meter"
                aria-label="Margin health"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(health * 100)}
                className={tone === "danger" ? "margin-health-danger" : undefined}
                style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}
              >
                <div style={{
                  width: `${Math.max(0, Math.min(1, health)) * 100}%`, height: "100%",
                  background: HEALTH_COLORS[tone], transition: "width 0.3s",
                }} />
              </div>
              <span title="Margin health: 100% at entry, 0% at the liq price"
                style={{ fontSize: 9, letterSpacing: 1, color: HEALTH_COLORS[tone], minWidth: 30, textAlign: "right" }}>
                {Math.round(health * 100)}%
              </span>
            </div>
            {markStale && (
              <div style={{ marginTop: 4, fontSize: 8, letterSpacing: 2, color: AMBER }}>
                FEED STALE · LIQUIDATIONS PAUSED
              </div>
            )}
          </div>
        )}

        {/* ── AT RISK ── */}
        {atRisk && distance !== null && (
          <div role="alert" data-testid="pos-at-risk" style={{
            marginBottom: 10, padding: "8px 10px", fontSize: 10, lineHeight: 1.45, letterSpacing: 0.5,
            color: AMBER, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.45)",
          }}>
            Near liquidation. A {distance.toFixed(1)}% move closes this trade
            {keep !== null && <> and you keep about {fmtUsd(keep)}</>}. Close it or reduce size.
          </div>
        )}

        {/* ── DETAILS ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 10, marginBottom: 10 }}>
          <div>
            <span style={smallLabel}>ENTRY</span>
            <div style={smallVal}>{fmtUsd(entry)}</div>
          </div>
          <div>
            <span style={smallLabel} title={isoView ? PRICE_HELP.mark : PRICE_HELP.last}>{isoView ? "MARK" : "LAST"}</span>
            <div style={smallVal} data-testid="pos-mark">
              {fmtUsd(mark)}
              {isoView && markStale && (
                <span
                  title="Price feed stale: liquidations are paused on this pair. Showing the last good mark."
                  style={{ marginLeft: 4, padding: "0 3px", fontSize: 8, letterSpacing: 1, color: AMBER, border: "1px solid rgba(245,158,11,0.5)" }}
                >
                  STALE
                </span>
              )}
            </div>
          </div>
          <div>
            <span style={smallLabel} title="Size, and its notional at entry (size × entry)">SIZE</span>
            <div style={smallVal} data-testid="pos-size">{fmtQty(qty)} {baseSymbol} · {fmtWholeUsd(qty * entry)}</div>
          </div>
          {isoView && (
            <div>
              <span style={smallLabel} title="The most this position can lose">MARGIN (AT RISK)</span>
              <div style={smallVal} data-testid="pos-margin">{fmtUsd(isoView.margin)}</div>
            </div>
          )}
          {breakEven !== null && (
            <div>
              <span style={smallLabel} title={`Closing here (at the ${pair.taker_fee_bps} bps taker fee) gets back every fee paid on this position`}>BREAK-EVEN</span>
              <div style={smallVal} data-testid="pos-breakeven">{fmtUsd(breakEven)}</div>
            </div>
          )}
          {feesPaid !== null && (
            <div>
              <span style={smallLabel} title="Fees paid on this position so far (open and adds)">FEES PAID</span>
              <div style={smallVal} data-testid="pos-fees">{fmtUsd(feesPaid)}</div>
            </div>
          )}
        </div>

        {/* ── TP / SL ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {triggerRow("TAKE_PROFIT_MARKET")}
          {triggerRow("STOP_MARKET")}
          {tslTrigger && (
            <div style={{ fontSize: 10, color: AMBER }}>
              <span style={smallLabel}>TSL </span>
              ${parseFloat(tslTrigger.trailing_offset ?? "0").toFixed(2)} offset (stop: {fmtUsd(parseFloat(tslTrigger.trigger_price))})
            </div>
          )}
          {triggerErr && <div role="alert" style={{ fontSize: 9, color: RED }}>{triggerErr}</div>}
        </div>

        {/* ${p}-pos-foot: at phone width the page's CSS stacks this row
            left-aligned, clear of the fixed Agent Activity button (bottom-right). */}
        <div className={`${p}-pos-foot`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4, fontSize: 9, letterSpacing: 1 }}>
          <span style={{ color: "rgba(255,255,255,0.4)" }} data-testid="pos-equity"
            title={isoView ? "Margin + unrealized P&L (a loss counts at most the margin)" : "Cost + unrealized P&L"}>
            equity {fmtUsd(equity)}
          </span>
          <button type="button" disabled={props.reversing} onClick={props.onReverse}
            style={{ ...linkBtn, color: "rgba(255,255,255,0.45)", fontSize: 9, textDecoration: "underline" }}>
            reverse to {reverseTo.toLowerCase()}…
          </button>
        </div>
      </div>
    </div>
  );
}
