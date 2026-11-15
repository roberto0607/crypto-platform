/**
 * The Swing Agent's decision at one closed 4h bar: pure rules, no I/O, no LLM.
 * The live agent and the backtest call this same function on a
 * `snapshotAt(series, k)` (swingSeries.ts), so they make the same decisions.
 *
 * Every rule is evaluated and returned on every call (pass / fail / null when
 * it can't apply yet), so a "no trade" says exactly what failed. The reason
 * code is the FIRST failing gate in this order:
 *
 *   open position → time stop (EXIT_TIME) or HOLD
 *   killed → halted_drawdown → daily_loss_limit → max_trades_today → cooldown
 *   → warmup → bias_neutral → daily_disagrees → adx_weak → no_setup
 *   → stop_invalid → room_to_target → target_too_close → entry
 *
 * Live-only guards (incomplete candles, late evaluation, stale or moved
 * Kraken price, order rejections) are the caller's; they wrap this decision.
 * Numbers: swingParams.ts.
 */
import { SWING_PARAMS as P } from "./swingParams";
import type { SwingLevel, SwingSnapshot } from "./swingSeries";

export type SwingVariant = "A" | "B";
export type SwingSide = "long" | "short";
export type SwingAction = "ENTER_LONG" | "ENTER_SHORT" | "EXIT_TIME" | "HOLD" | "NO_TRADE";

export const SWING_REASON_CODES = [
  "entry",
  "time_stop",
  "position_open",
  "killed",
  "halted_drawdown",
  "daily_loss_limit",
  "max_trades_today",
  "cooldown",
  "warmup",
  "bias_neutral",
  "daily_disagrees",
  "adx_weak",
  "no_setup",
  "stop_invalid",
  "room_to_target",
  "target_too_close",
] as const;
export type SwingReasonCode = (typeof SWING_REASON_CODES)[number];

export interface SwingPosition {
  side: SwingSide;
  /** Open time of the 4h bar the entry filled in (the bar after the signal). */
  entryBarTime: number;
  qty: number;
  entryPrice: number;
  stop: number;
  target: number;
}

export interface SwingAccount {
  /** Marked to market at the decision. */
  equity: number;
  peakEquity: number;
  /** Equity at the start of the decision's UTC day. */
  dayStartEquity: number;
  /** Entries already made in the decision's UTC day. */
  entriesToday: number;
  killed: boolean;
  position: SwingPosition | null;
  /** When the last position closed (epoch s), or null. */
  lastExitTime: number | null;
}

/** Per side, as basis points of notional. */
export interface SwingCosts {
  takerFeeBps: number;
  slippageBps: number;
}

export interface SwingRule {
  id: string;
  label: string;
  /** null = can't be evaluated (warm-up, or no side to test against). */
  pass: boolean | null;
  value: string;
  threshold: string;
}

export type SwingStopSource = "structure_4h" | "structure_1d" | "atr";
export type SwingTargetSource = "2R" | "sr_4h" | "sr_1d" | "pdh" | "pdl" | "pwh" | "pwl";

export interface SwingPlan {
  side: SwingSide;
  /** The decision close; the fill lands near it. */
  entryRef: number;
  stop: number;
  stopSource: SwingStopSource;
  /** Stop distance, price units. */
  r: number;
  target: number;
  targetSource: SwingTargetSource;
  targetR: number;
  riskUsd: number;
  qty: number;
  notional: number;
  /** True when the 1x notional cap made the size (risk is then under 1%). */
  sizeCapped: boolean;
}

export interface SwingDecision {
  barTime: number;
  closeTime: number;
  variant: SwingVariant;
  action: SwingAction;
  /** The side acted on (entry, or the held/closed position); null for NO_TRADE. */
  side: SwingSide | null;
  /** The side the setup rules were tested for: the weekly bias, else the setup's own. */
  candidateSide: SwingSide | null;
  reasonCode: SwingReasonCode;
  /** Plain English, with the numbers. */
  reason: string;
  rules: SwingRule[];
  inputs: SwingSnapshot;
  /** Set only on an entry. */
  plan: SwingPlan | null;
  /** The drawdown halt tripped: the caller sets the kill switch. */
  requestHalt: boolean;
}

// ── formatting ──

const px = (v: number | null | undefined): string =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f2 = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : v.toFixed(2));
const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const floor8 = (v: number): number => Math.floor(v * 1e8 + 1e-6) / 1e8;
/** Tolerance for "exactly at the boundary" comparisons on prices. */
const EPS = 1e-9;

const STOP_TEXT: Record<SwingStopSource, string> = {
  structure_4h: "behind the 4h S/R zone",
  structure_1d: "behind the daily S/R zone",
  atr: `${P.stop.atrMult} ATR`,
};
const TARGET_TEXT: Record<SwingTargetSource, string> = {
  "2R": `${P.target.r}R`,
  sr_4h: "in front of the 4h S/R zone",
  sr_1d: "in front of the daily S/R zone",
  pdh: "in front of the previous day's high",
  pdl: "in front of the previous day's low",
  pwh: "in front of the previous week's high",
  pwl: "in front of the previous week's low",
};

// ── stop / room / target ──

interface StopCalc { stop: number; source: SwingStopSource; r: number; pctOfPrice: number }

function computeStop(side: SwingSide, entry: number, atr: number, levels: SwingLevel[]): StopCalc {
  const S = P.stop;
  let structural: { stop: number; tf: SwingLevel["tf"] } | null = null;
  if (side === "long") {
    const sup = levels.filter((l) => l.role === "support" && l.bottom < entry).sort((a, b) => b.bottom - a.bottom)[0];
    if (sup) structural = { stop: sup.bottom - S.structureBufferAtr * atr, tf: sup.tf };
  } else {
    const res = levels.filter((l) => l.role === "resistance" && l.top > entry).sort((a, b) => a.top - b.top)[0];
    if (res) structural = { stop: res.top + S.structureBufferAtr * atr, tf: res.tf };
  }
  let stop: number;
  let source: SwingStopSource;
  const dist = structural ? Math.abs(entry - structural.stop) : NaN;
  if (structural && dist >= S.structureMinAtr * atr - EPS && dist <= S.structureMaxAtr * atr + EPS) {
    stop = structural.stop;
    source = structural.tf === "4h" ? "structure_4h" : "structure_1d";
  } else {
    stop = side === "long" ? entry - S.atrMult * atr : entry + S.atrMult * atr;
    source = "atr";
  }
  const r = Math.abs(entry - stop);
  return { stop, source, r, pctOfPrice: r / entry };
}

/** The nearest opposing S/R zone edge: resistances above a long, supports below a short. */
function nearestOpposing(side: SwingSide, entry: number, levels: SwingLevel[]): { level: SwingLevel; dist: number } | null {
  let best: { level: SwingLevel; dist: number } | null = null;
  for (const l of levels) {
    let dist: number;
    if (side === "long") {
      if (l.role !== "resistance" || l.top <= entry) continue;
      dist = Math.max(0, l.bottom - entry);
    } else {
      if (l.role !== "support" || l.bottom >= entry) continue;
      dist = Math.max(0, entry - l.top);
    }
    if (best === null || dist < best.dist) best = { level: l, dist };
  }
  return best;
}

function computeTarget(
  side: SwingSide, entry: number, r: number, atr: number, s: SwingSnapshot,
): { target: number; source: SwingTargetSource; targetR: number } {
  const buf = P.target.levelBufferAtr * atr;
  const long = side === "long";
  const cands: Array<{ price: number; source: SwingTargetSource }> = [
    { price: long ? entry + P.target.r * r : entry - P.target.r * r, source: "2R" },
  ];
  for (const l of s.levels) {
    const source: SwingTargetSource = l.tf === "4h" ? "sr_4h" : "sr_1d";
    if (long && l.role === "resistance" && l.bottom > entry) cands.push({ price: l.bottom - buf, source });
    if (!long && l.role === "support" && l.top < entry) cands.push({ price: l.top + buf, source });
  }
  const keyLevels: Array<[number | null, SwingTargetSource]> = long
    ? [[s.pdh, "pdh"], [s.pwh, "pwh"]]
    : [[s.pdl, "pdl"], [s.pwl, "pwl"]];
  for (const [v, source] of keyLevels) {
    if (v === null) continue;
    if (long && v > entry) cands.push({ price: v - buf, source });
    if (!long && v < entry) cands.push({ price: v + buf, source });
  }
  // The closest candidate to the entry; ties keep the earlier (2R first).
  let best = cands[0]!;
  for (const c of cands) if (long ? c.price < best.price : c.price > best.price) best = c;
  return { target: best.price, source: best.source, targetR: (long ? best.price - entry : entry - best.price) / r };
}

// ── evaluation ──

export function evaluateSwing(
  s: SwingSnapshot,
  acct: SwingAccount,
  variant: SwingVariant,
  costs: SwingCosts,
): SwingDecision {
  const L = P.limits;
  const rules: SwingRule[] = [];
  const add = (id: string, label: string, pass: boolean | null, value: string, threshold: string): boolean | null => {
    rules.push({ id, label, pass, value, threshold });
    return pass;
  };

  // ── account gates ──
  const ddLimit = acct.peakEquity * (1 - L.drawdownHaltPct);
  const ddBreach = acct.equity <= ddLimit + 1e-6;
  const dayLimit = acct.dayStartEquity * (1 - L.dailyLossPct);
  const dayBreach = acct.equity <= dayLimit + 1e-6;
  const sinceExit = acct.lastExitTime === null ? null : s.closeTime - acct.lastExitTime;
  const inCooldown = sinceExit !== null && sinceExit < L.cooldownSec;
  add("kill_switch", "Kill switch off", !acct.killed, acct.killed ? "on" : "off", "off");
  add("drawdown", "Equity above the drawdown halt", !ddBreach,
    `${px(acct.equity)} (peak ${px(acct.peakEquity)})`, `> ${px(ddLimit)} (−${pct(L.drawdownHaltPct)})`);
  add("daily_loss", "Daily loss under the limit", !dayBreach,
    `${px(acct.equity)} (day start ${px(acct.dayStartEquity)})`, `> ${px(dayLimit)} (−${pct(L.dailyLossPct)})`);
  add("entries_today", "Entries today under the max", acct.entriesToday < L.maxEntriesPerDay,
    String(acct.entriesToday), `< ${L.maxEntriesPerDay}`);
  add("cooldown", "One full bar since the last exit", !inCooldown,
    sinceExit === null ? "no exit yet" : `${Math.round(sinceExit / 60)} min`, `>= ${L.cooldownSec / 60} min`);
  add("flat", "No open position", acct.position === null, acct.position ? acct.position.side : "flat", "flat");

  // ── data ──
  const missing: string[] = [];
  if (!s.weekly || s.weekly.sma50 === null || s.weekly.sma200 === null) missing.push("weekly SMA 50/200");
  if (!s.daily || s.daily.sma200 === null) missing.push("daily SMA 200");
  if (s.adx === null) missing.push("ADX 14");
  if (s.atr14 === null) missing.push("ATR 14");
  if (variant === "A") {
    if (s.ema20 === null || s.ema50 === null) missing.push("EMA 20/50");
    if (s.rsi14 === null) missing.push("RSI 14");
    if (s.window.length < P.pullback.lookbackBars || s.window.some((b) => b.ema20 === null || b.ema50 === null)) {
      missing.push(`${P.pullback.lookbackBars} bars of EMA 20/50`);
    }
  } else if (s.utStop === null) {
    missing.push("UT Bot stop");
  }
  add("data", "Enough history for every input", missing.length === 0,
    missing.length ? `missing ${missing.join(", ")}` : "complete", "complete");

  // ── market ──
  let bias: SwingSide | null = null;
  const w = s.weekly;
  if (w && w.sma50 !== null && w.sma200 !== null) {
    if (w.close > w.sma50 && w.close > w.sma200) bias = "long";
    else if (w.close < w.sma50 && w.close < w.sma200) bias = "short";
  }
  let nativeSide: SwingSide | null = null;
  if (variant === "A" && s.ema20 !== null && s.ema50 !== null && s.ema20 !== s.ema50) {
    nativeSide = s.ema20 > s.ema50 ? "long" : "short";
  }
  if (variant === "B" && s.utSignal) nativeSide = s.utSignal === "buy" ? "long" : "short";
  const side: SwingSide | null = bias ?? nativeSide;
  const long = side === "long";

  add("weekly_bias", "Weekly close above both SMAs (long) or below both (short)",
    w && w.sma50 !== null && w.sma200 !== null ? bias !== null : null,
    w ? `close ${px(w.close)} · SMA 50 ${px(w.sma50)} · SMA 200 ${px(w.sma200)}` : "—",
    "above both / below both");
  const d = s.daily;
  add("daily_filter", "Daily close agrees with the bias (vs daily SMA 200)",
    d && d.sma200 !== null && side ? (long ? d.close > d.sma200 : d.close < d.sma200) : null,
    d ? `close ${px(d.close)} · SMA 200 ${px(d.sma200)}` : "—",
    side ? (long ? "close > SMA 200" : "close < SMA 200") : "agrees with the bias");
  add("adx", "4h ADX strong enough", s.adx === null ? null : s.adx >= P.adx.min - EPS, f2(s.adx), `>= ${P.adx.min}`);

  // ── setup ──
  const setupIds: string[] = [];
  const setup = (id: string, label: string, pass: boolean | null, value: string, threshold: string) => {
    setupIds.push(id);
    add(id, label, pass, value, threshold);
  };
  if (variant === "A") {
    const ok = side !== null && s.ema20 !== null && s.ema50 !== null;
    const e20 = s.ema20 ?? NaN;
    const e50 = s.ema50 ?? NaN;
    const fullWindow = s.window.length >= P.pullback.lookbackBars && s.window.every((b) => b.ema20 !== null && b.ema50 !== null);
    const [rLo, rHi] = long ? P.pullback.rsiLong : P.pullback.rsiShort;
    setup("a_trend", long ? "EMA 20 above EMA 50" : "EMA 20 below EMA 50",
      ok ? (long ? e20 > e50 : e20 < e50) : null, `EMA 20 ${px(s.ema20)} · EMA 50 ${px(s.ema50)}`, long ? "EMA 20 > EMA 50" : "EMA 20 < EMA 50");
    setup("a_above_ema50", long ? "Close above EMA 50" : "Close below EMA 50",
      ok ? (long ? s.close > e50 : s.close < e50) : null, `close ${px(s.close)}`, `${long ? ">" : "<"} ${px(s.ema50)}`);
    setup("a_pullback",
      long ? `Pullback: a low in the last ${P.pullback.lookbackBars} bars reached EMA 20` : `Pullback: a high in the last ${P.pullback.lookbackBars} bars reached EMA 20`,
      ok && fullWindow ? s.window.some((b) => (long ? b.low <= b.ema20! : b.high >= b.ema20!)) : null,
      s.window.map((b) => (long ? `low ${px(b.low)} / EMA 20 ${px(b.ema20)}` : `high ${px(b.high)} / EMA 20 ${px(b.ema20)}`)).join(" · "),
      long ? "a low <= EMA 20" : "a high >= EMA 20");
    setup("a_reclaim", long ? "Reclaim: close above EMA 20 and above the open" : "Reject: close below EMA 20 and below the open",
      ok ? (long ? s.close > e20 && s.close > s.open : s.close < e20 && s.close < s.open) : null,
      `open ${px(s.open)} · close ${px(s.close)} · EMA 20 ${px(s.ema20)}`, long ? "close > EMA 20, close > open" : "close < EMA 20, close < open");
    setup("a_hold_ema50", long ? `No close below EMA 50 in the last ${P.pullback.lookbackBars} bars` : `No close above EMA 50 in the last ${P.pullback.lookbackBars} bars`,
      ok && fullWindow ? s.window.every((b) => (long ? b.close >= b.ema50! : b.close <= b.ema50!)) : null,
      s.window.map((b) => `close ${px(b.close)} / EMA 50 ${px(b.ema50)}`).join(" · "), long ? "closes >= EMA 50" : "closes <= EMA 50");
    setup("a_rsi", `RSI 14 in [${rLo}, ${rHi}]`,
      side !== null && s.rsi14 !== null ? s.rsi14 >= rLo - EPS && s.rsi14 <= rHi + EPS : null, f2(s.rsi14), `${rLo}–${rHi}`);
  } else {
    const want = long ? "buy" : "sell";
    setup("b_signal", `UT Bot ${side ? want : "buy/sell"} signal on this bar`,
      side !== null && s.utStop !== null ? s.utSignal === want : null,
      `${s.utSignal ?? "no signal"} · UT stop ${px(s.utStop)}`, side ? want : "a signal in the bias direction");
  }
  const setupPass = setupIds.every((id) => rules.find((r) => r.id === id)!.pass === true);

  // ── stop / room / target (for the candidate side) ──
  const atr = s.atr14;
  const stopCalc = side && atr !== null ? computeStop(side, s.close, atr, s.levels) : null;
  const stopOk = stopCalc ? stopCalc.pctOfPrice >= P.stop.minPct - EPS && stopCalc.pctOfPrice <= P.stop.maxPct + EPS : null;
  add("stop", "Stop 0.5%–8% from the entry", stopOk,
    stopCalc ? `${px(stopCalc.stop)} (${STOP_TEXT[stopCalc.source]}, ${pct(stopCalc.pctOfPrice)})` : "—",
    `${pct(P.stop.minPct)}–${pct(P.stop.maxPct)}`);
  const opp = stopCalc && side ? nearestOpposing(side, s.close, s.levels) : null;
  const roomR = stopCalc && opp ? opp.dist / stopCalc.r : null;
  add("room", "Nearest opposing S/R at least 1.5R away",
    stopCalc ? (roomR === null ? true : roomR >= P.target.minRoomR - EPS) : null,
    stopCalc ? (opp ? `${opp.level.tf} ${opp.level.role} ${px(opp.level.bottom)}–${px(opp.level.top)}, ${f2(roomR)}R` : "none") : "—",
    `>= ${P.target.minRoomR}R`);
  const tgt = stopCalc && side && atr !== null ? computeTarget(side, s.close, stopCalc.r, atr, s) : null;
  add("target", "Target at least 1.5R", tgt ? tgt.targetR >= P.target.minR - EPS : null,
    tgt ? `${px(tgt.target)} (${TARGET_TEXT[tgt.source]}), ${f2(tgt.targetR)}R` : "—", `>= ${P.target.minR}R`);

  // ── decision ──
  const pass = (id: string) => rules.find((r) => r.id === id)!.pass === true;
  const base = {
    barTime: s.barTime, closeTime: s.closeTime, variant, candidateSide: side, rules, inputs: s,
    requestHalt: ddBreach && !acct.killed,
  };
  const noTrade = (reasonCode: SwingReasonCode, reason: string): SwingDecision =>
    ({ ...base, action: "NO_TRADE", side: null, reasonCode, reason, plan: null });

  if (acct.position) {
    const pos = acct.position;
    const bars = Math.round((s.barTime - pos.entryBarTime) / P.timeframeSec) + 1;
    if (bars >= L.timeStopBars) {
      return { ...base, action: "EXIT_TIME", side: pos.side, reasonCode: "time_stop", plan: null,
        reason: `Close the ${pos.side} position: this is bar ${bars} of the trade, the ${L.timeStopBars}-bar time stop.` };
    }
    return { ...base, action: "HOLD", side: pos.side, reasonCode: "position_open", plan: null,
      reason: `Holding the ${pos.side} position (bar ${bars} of ${L.timeStopBars}): entry ${px(pos.entryPrice)}, stop ${px(pos.stop)}, target ${px(pos.target)}. No new entries while a position is open.` };
  }
  if (acct.killed) {
    return noTrade("killed", "No trade: the kill switch is on. New entries are blocked; stops, targets and closes still work.");
  }
  if (ddBreach) {
    return noTrade("halted_drawdown",
      `No trade: equity ${px(acct.equity)} is ${pct(1 - acct.equity / acct.peakEquity)} below its peak ${px(acct.peakEquity)} (halt at ${pct(L.drawdownHaltPct)}). The agent stops itself until an admin re-arms it.`);
  }
  if (dayBreach) {
    return noTrade("daily_loss_limit",
      `No trade: equity is down ${pct(1 - acct.equity / acct.dayStartEquity)} today (limit ${pct(L.dailyLossPct)}). New entries resume on the next UTC day.`);
  }
  if (acct.entriesToday >= L.maxEntriesPerDay) {
    return noTrade("max_trades_today", `No trade: already ${acct.entriesToday} entries today (max ${L.maxEntriesPerDay} per UTC day).`);
  }
  if (inCooldown) {
    return noTrade("cooldown",
      `No trade: the last position closed ${Math.round(sinceExit! / 60)} min ago; the agent waits one full 4h bar after an exit.`);
  }
  if (missing.length) return noTrade("warmup", `No trade: not enough history yet for ${missing.join(", ")}.`);
  if (bias === null) {
    return noTrade("bias_neutral",
      `No trade: the weekly close ${px(w!.close)} is between SMA 50 (${px(w!.sma50)}) and SMA 200 (${px(w!.sma200)}), so the weekly bias is neutral.`);
  }
  if (!pass("daily_filter")) {
    return noTrade("daily_disagrees",
      `No trade: the weekly bias is ${bias} but the daily close ${px(d!.close)} is ${long ? "below" : "above"} the daily SMA 200 (${px(d!.sma200)}).`);
  }
  if (!pass("adx")) return noTrade("adx_weak", `No trade: 4h ADX ${f2(s.adx)} is under ${P.adx.min}; the trend is too weak.`);
  if (!setupPass) {
    if (variant === "B") {
      const against = s.utSignal !== null && (s.utSignal === "buy") !== long;
      return noTrade("no_setup", against
        ? `No trade: UT Bot gave a ${s.utSignal} signal, against the ${bias} bias.`
        : `No trade: ${bias} bias, but no UT Bot ${long ? "buy" : "sell"} signal on this bar.`);
    }
    const failed = rules.filter((r) => setupIds.includes(r.id) && r.pass !== true).map((r) => `${r.label} (${r.value})`);
    return noTrade("no_setup", `No trade: ${bias} bias, but no pullback setup. Failed: ${failed.join("; ")}.`);
  }
  const sc = stopCalc!;
  if (!stopOk) {
    return noTrade("stop_invalid",
      `No trade: the stop would be ${pct(sc.pctOfPrice)} away (${px(sc.stop)}, ${STOP_TEXT[sc.source]}); it must be ${pct(P.stop.minPct)}–${pct(P.stop.maxPct)}.`);
  }
  if (!pass("room")) {
    const o = opp!;
    return noTrade("room_to_target",
      `No trade: the nearest ${o.level.role} (${o.level.tf} ${px(o.level.bottom)}–${px(o.level.top)}) is ${f2(roomR)}R away; needs ${P.target.minRoomR.toFixed(2)}R.`);
  }
  const t = tgt!;
  if (!pass("target")) {
    return noTrade("target_too_close",
      `No trade: the target ${px(t.target)} (${TARGET_TEXT[t.source]}) is only ${f2(t.targetR)}R away; needs ${P.target.minR.toFixed(2)}R.`);
  }

  // ── size ──
  const riskUsd = acct.equity * P.risk.perTrade;
  const costPerUnit = (s.close * 2 * (costs.takerFeeBps + costs.slippageBps)) / 10_000;
  const qtyRisk = riskUsd / (sc.r + costPerUnit);
  const qtyCap = (acct.equity * P.risk.maxNotionalOfEquity) / s.close;
  const qty = floor8(Math.min(qtyRisk, qtyCap));
  const plan: SwingPlan = {
    side: bias,
    entryRef: s.close,
    stop: sc.stop,
    stopSource: sc.source,
    r: sc.r,
    target: t.target,
    targetSource: t.source,
    targetR: t.targetR,
    riskUsd,
    qty,
    notional: qty * s.close,
    sizeCapped: qtyCap < qtyRisk,
  };
  const setupText = variant === "A"
    ? `4h pullback to EMA 20 (${px(s.ema20)}) with RSI ${f2(s.rsi14)}`
    : `UT Bot ${long ? "buy" : "sell"} signal`;
  return {
    ...base,
    action: long ? "ENTER_LONG" : "ENTER_SHORT",
    side: bias,
    reasonCode: "entry",
    plan,
    reason:
      `Enter ${bias} at ~${px(s.close)}: weekly close ${px(w!.close)} ${long ? "above" : "below"} SMA 50/200, ` +
      `daily close ${long ? "above" : "below"} SMA 200 (${px(d!.sma200)}), ADX ${f2(s.adx)}, ${setupText}. ` +
      `Stop ${px(sc.stop)} (${STOP_TEXT[sc.source]}, ${pct(sc.pctOfPrice)}), target ${px(t.target)} (${f2(t.targetR)}R, ${TARGET_TEXT[t.source]}). ` +
      `Size ${qty} BTC (${px(plan.notional)} notional${plan.sizeCapped ? ", capped at 1x" : ""}), risking ${px(riskUsd)}.`,
  };
}
