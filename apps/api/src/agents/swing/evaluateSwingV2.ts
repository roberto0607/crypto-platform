/**
 * Swing Agent v2's decision at one closed 4h bar: pure rules, no I/O, no LLM.
 * Same contract as v1 (evaluateSwing.ts): it reads a `snapshotAt(series, k)`,
 * every rule is returned on every call, and the reason code is the FIRST
 * failing gate in this order:
 *
 *   open position → EMA 50 close exit (EXIT_TREND) or HOLD
 *   killed → halted_drawdown → daily_loss_limit → max_trades_today → cooldown
 *   → warmup → bias_neutral → daily_disagrees → adx_weak → no_setup
 *   → stop_invalid → room_htf → entry
 *
 * v2 vs v1 (numbers: swingParamsV2.ts): weekly bias from SMA 50w only, room
 * on daily/weekly S/R only (>= 1.0R), no target, no time stop, exit on a 4h
 * close across EMA 50. Setup and stop are v1 Variant A's, the same code.
 */
import {
  computeStop, nearestOpposing, pullbackMissing, pullbackRules, STOP_TEXT,
  type SwingAccount, type SwingCosts, type SwingRule, type SwingSide, type SwingStopSource,
} from "./evaluateSwing";
import { SWING_PARAMS_V2 as P } from "./swingParamsV2";
import type { SwingSnapshot } from "./swingSeries";

export type SwingV2Action = "ENTER_LONG" | "ENTER_SHORT" | "EXIT_TREND" | "HOLD" | "NO_TRADE";

export const SWING_V2_REASON_CODES = [
  "entry",
  "trend_exit",
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
  "room_htf",
] as const;
export type SwingV2ReasonCode = (typeof SWING_V2_REASON_CODES)[number];

export interface SwingV2Plan {
  side: SwingSide;
  entryRef: number;
  stop: number;
  stopSource: SwingStopSource;
  r: number;
  /** v2 has no target: the exit is the EMA 50 close (or the stop). */
  target: null;
  targetSource: null;
  /** Nearest opposing daily/weekly S/R in R; null when there is none. */
  roomR: number | null;
  riskUsd: number;
  qty: number;
  notional: number;
  sizeCapped: boolean;
}

export interface SwingV2Decision {
  barTime: number;
  closeTime: number;
  action: SwingV2Action;
  side: SwingSide | null;
  /** The side the setup was tested for (the weekly bias). */
  candidateSide: SwingSide | null;
  reasonCode: SwingV2ReasonCode;
  reason: string;
  rules: SwingRule[];
  inputs: SwingSnapshot;
  plan: SwingV2Plan | null;
  /**
   * The room check's value in R whenever it was evaluated (setup passed and
   * the stop was valid): a number, "none" (no opposing level), or null when
   * the decision didn't reach it. For the report's room distribution.
   */
  roomR: number | "none" | null;
  requestHalt: boolean;
}

const px = (v: number | null | undefined): string =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f2 = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : v.toFixed(2));
const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const floor8 = (v: number): number => Math.floor(v * 1e8 + 1e-6) / 1e8;
const EPS = 1e-9;

export function evaluateSwingV2(s: SwingSnapshot, acct: SwingAccount, costs: SwingCosts): SwingV2Decision {
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
  if (!s.weekly || s.weekly.sma50 === null) missing.push(`weekly SMA ${P.weeklySma}`);
  if (!s.daily || s.daily.sma200 === null) missing.push(`daily SMA ${P.dailySma}`);
  if (s.adx === null) missing.push("ADX 14");
  if (s.atr14 === null) missing.push("ATR 14");
  missing.push(...pullbackMissing(s));
  add("data", "Enough history for every input", missing.length === 0,
    missing.length ? `missing ${missing.join(", ")}` : "complete", "complete");

  // ── market ──
  const w = s.weekly;
  let bias: SwingSide | null = null;
  if (w && w.sma50 !== null) {
    if (w.close > w.sma50) bias = "long";
    else if (w.close < w.sma50) bias = "short";
  }
  const long = bias === "long";
  add("weekly_bias", `Weekly close above SMA ${P.weeklySma} (long) or below (short)`,
    w && w.sma50 !== null ? bias !== null : null,
    w ? `close ${px(w.close)} · SMA ${P.weeklySma} ${px(w.sma50)}` : "—", `≠ SMA ${P.weeklySma}`);
  const d = s.daily;
  add("daily_filter", `Daily close agrees with the bias (vs daily SMA ${P.dailySma})`,
    d && d.sma200 !== null && bias ? (long ? d.close > d.sma200 : d.close < d.sma200) : null,
    d ? `close ${px(d.close)} · SMA ${P.dailySma} ${px(d.sma200)}` : "—",
    bias ? (long ? `close > SMA ${P.dailySma}` : `close < SMA ${P.dailySma}`) : "agrees with the bias");
  add("adx", "4h ADX strong enough", s.adx === null ? null : s.adx >= P.adx.min - EPS, f2(s.adx), `>= ${P.adx.min}`);

  // ── setup (v1 Variant A, unchanged) ──
  const setupRules = pullbackRules(s, bias);
  rules.push(...setupRules);
  const setupPass = setupRules.every((r) => r.pass === true);

  // ── stop / room ──
  const atr = s.atr14;
  const stopCalc = bias && atr !== null ? computeStop(bias, s.close, atr, s.levels) : null;
  const stopOk = stopCalc ? stopCalc.pctOfPrice >= P.stop.minPct - EPS && stopCalc.pctOfPrice <= P.stop.maxPct + EPS : null;
  add("stop", "Stop 0.5%–8% from the entry", stopOk,
    stopCalc ? `${px(stopCalc.stop)} (${STOP_TEXT[stopCalc.source]}, ${pct(stopCalc.pctOfPrice)})` : "—",
    `${pct(P.stop.minPct)}–${pct(P.stop.maxPct)}`);
  const htfLevels = [...s.levels.filter((l) => l.tf === "1d"), ...s.levels1w];
  const opp = stopCalc && bias ? nearestOpposing(bias, s.close, htfLevels) : null;
  const roomR = stopCalc && opp ? opp.dist / stopCalc.r : null;
  add("room", `Nearest opposing daily/weekly S/R at least ${P.room.minR}R away`,
    stopCalc ? (roomR === null ? true : roomR >= P.room.minR - EPS) : null,
    stopCalc ? (opp ? `${opp.level.tf} ${opp.level.role} ${px(opp.level.bottom)}–${px(opp.level.top)}, ${f2(roomR)}R` : "none") : "—",
    `>= ${P.room.minR}R`);

  // ── decision ──
  const pass = (id: string) => rules.find((r) => r.id === id)!.pass === true;
  const base = {
    barTime: s.barTime, closeTime: s.closeTime, candidateSide: bias, rules, inputs: s,
    requestHalt: ddBreach && !acct.killed, roomR: null as SwingV2Decision["roomR"],
  };
  const noTrade = (reasonCode: SwingV2ReasonCode, reason: string): SwingV2Decision =>
    ({ ...base, action: "NO_TRADE", side: null, reasonCode, reason, plan: null });

  if (acct.position) {
    const pos = acct.position;
    const e50 = s.ema50;
    const broken = e50 !== null && (pos.side === "long" ? s.close < e50 : s.close > e50);
    add("exit_ema50", pos.side === "long" ? "4h close below EMA 50 (exit)" : "4h close above EMA 50 (exit)",
      e50 === null ? null : broken, `close ${px(s.close)} · EMA 50 ${px(e50)}`, pos.side === "long" ? "close < EMA 50" : "close > EMA 50");
    if (broken) {
      return { ...base, candidateSide: pos.side, action: "EXIT_TREND", side: pos.side, reasonCode: "trend_exit", plan: null,
        reason: `Close the ${pos.side} position at the next open: the 4h close ${px(s.close)} is ${pos.side === "long" ? "below" : "above"} EMA 50 (${px(e50)}).` };
    }
    return { ...base, candidateSide: pos.side, action: "HOLD", side: pos.side, reasonCode: "position_open", plan: null,
      reason: `Holding the ${pos.side} position: entry ${px(pos.entryPrice)}, stop ${px(pos.stop)}; exits on a 4h close ${pos.side === "long" ? "below" : "above"} EMA 50 (${px(e50)}) or at the stop.` };
  }
  if (acct.killed) {
    return noTrade("killed", "No trade: the kill switch is on. New entries are blocked; stops and closes still work.");
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
    return noTrade("bias_neutral", `No trade: the weekly close ${px(w!.close)} is exactly on SMA ${P.weeklySma} (${px(w!.sma50)}).`);
  }
  if (!pass("daily_filter")) {
    return noTrade("daily_disagrees",
      `No trade: the weekly bias is ${bias} but the daily close ${px(d!.close)} is ${long ? "below" : "above"} the daily SMA ${P.dailySma} (${px(d!.sma200)}).`);
  }
  if (!pass("adx")) return noTrade("adx_weak", `No trade: 4h ADX ${f2(s.adx)} is under ${P.adx.min}; the trend is too weak.`);
  if (!setupPass) {
    const failed = setupRules.filter((r) => r.pass !== true).map((r) => `${r.label} (${r.value})`);
    return noTrade("no_setup", `No trade: ${bias} bias, but no pullback setup. Failed: ${failed.join("; ")}.`);
  }
  const sc = stopCalc!;
  if (!stopOk) {
    return noTrade("stop_invalid",
      `No trade: the stop would be ${pct(sc.pctOfPrice)} away (${px(sc.stop)}, ${STOP_TEXT[sc.source]}); it must be ${pct(P.stop.minPct)}–${pct(P.stop.maxPct)}.`);
  }
  base.roomR = roomR ?? "none";
  if (!pass("room")) {
    const o = opp!;
    return noTrade("room_htf",
      `No trade: the nearest ${o.level.tf === "1w" ? "weekly" : "daily"} ${o.level.role} (${px(o.level.bottom)}–${px(o.level.top)}) is ${f2(roomR)}R away; needs ${P.room.minR.toFixed(2)}R.`);
  }

  // ── size (v1's rule) ──
  const riskUsd = acct.equity * P.risk.perTrade;
  const costPerUnit = (s.close * 2 * (costs.takerFeeBps + costs.slippageBps)) / 10_000;
  const qtyRisk = riskUsd / (sc.r + costPerUnit);
  const qtyCap = (acct.equity * P.risk.maxNotionalOfEquity) / s.close;
  const qty = floor8(Math.min(qtyRisk, qtyCap));
  const plan: SwingV2Plan = {
    side: bias, entryRef: s.close, stop: sc.stop, stopSource: sc.source, r: sc.r, target: null, targetSource: null,
    roomR, riskUsd, qty, notional: qty * s.close, sizeCapped: qtyCap < qtyRisk,
  };
  return {
    ...base,
    action: long ? "ENTER_LONG" : "ENTER_SHORT",
    side: bias,
    reasonCode: "entry",
    plan,
    reason:
      `Enter ${bias} at ~${px(s.close)}: weekly close ${px(w!.close)} ${long ? "above" : "below"} SMA ${P.weeklySma}, ` +
      `daily close ${long ? "above" : "below"} SMA ${P.dailySma} (${px(d!.sma200)}), ADX ${f2(s.adx)}, ` +
      `4h pullback to EMA 20 (${px(s.ema20)}) with RSI ${f2(s.rsi14)}. ` +
      `Stop ${px(sc.stop)} (${STOP_TEXT[sc.source]}, ${pct(sc.pctOfPrice)}); room to daily/weekly S/R ${roomR === null ? "open" : `${f2(roomR)}R`}; ` +
      `no target, exits on a 4h close ${long ? "below" : "above"} EMA 50. ` +
      `Size ${qty} BTC (${px(plan.notional)} notional${plan.sizeCapped ? ", capped at 1x" : ""}), risking ${px(riskUsd)}.`,
  };
}
