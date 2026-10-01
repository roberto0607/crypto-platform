/** Pure helpers for the landing hero. */

export type Panel = "live" | "idle";

/**
 * Which right-hand panel to show. A live match takes over — except while a
 * quick-call round is in progress on the idle panel: that round finishes
 * (including its result) before the panel switches.
 */
export function nextPanel(current: Panel, hasLiveMatch: boolean, roundInProgress: boolean): Panel {
  if (!hasLiveMatch) return "idle";
  if (current === "idle" && roundInProgress) return "idle";
  return "live";
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatPrice(price: string): string {
  return usd.format(Number(price));
}

export function formatSignedPct(pct: number): string {
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;
}

export function formatSignedUsd(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${usd.format(Math.abs(value))}`;
}

/** 93784 → "1d 02:03:04"; 3723 → "01:02:03". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hh = String(Math.floor((s % 86_400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${days > 0 ? `${days}d ` : ""}${hh}:${mm}:${ss}`;
}

export const HANDLE_RE = /^[a-zA-Z0-9_]{3,30}$/;
