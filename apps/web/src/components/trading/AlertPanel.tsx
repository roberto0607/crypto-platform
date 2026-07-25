import { useState, useRef, useEffect } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { resendVerification } from "@/api/endpoints/auth";
import { createAlert, listAlerts, cancelAlert } from "@/api/endpoints/alerts";
import type { Alert, AlertConditionType } from "@/types/api";

// Gate 1 — this bell icon now hosts two tabs: PRICE ALERTS (this file's
// original content, unchanged) and NOTIFICATIONS (ported from
// NotificationBell.tsx, which stays as the header's own bell on every
// non-/trade route). NotificationBell's fetch/SSE-push data flow (App.tsx
// init + useSSE's onNotificationCreated) is untouched — this only relocates
// the UI container on /trade; unreadCount keeps updating in the background
// regardless of which tab/route is active.
const NOTIF_KIND_ICONS: Record<string, string> = {
  COMPETITION_STARTED: "!",
  COMPETITION_ENDED: "*",
  RANK_CHANGED: "#",
  TRIGGER_FIRED: "T",
  ORDER_FILLED: "$",
  SYSTEM: "i",
};

const CONDITION_OPTIONS: { value: AlertConditionType; label: string }[] = [
  { value: "CROSSING", label: "Crossing" },
  { value: "CROSSING_UP", label: "Crossing Up" },
  { value: "CROSSING_DOWN", label: "Crossing Down" },
];

const CONDITION_LABELS: Record<AlertConditionType, string> = {
  CROSSING: "Crossing",
  CROSSING_UP: "Crossing Up",
  CROSSING_DOWN: "Crossing Down",
};

interface AlertPanelProps {
  pairId: string | null | undefined;
  pairSymbol: string | undefined;
}

export function AlertPanel({ pairId, pairSymbol }: AlertPanelProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"alerts" | "notifications">("alerts");
  const ref = useRef<HTMLDivElement>(null);
  const user = useAuthStore((s) => s.user);

  const {
    notifications,
    unreadCount,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    fetch: fetchNotifications,
  } = useNotificationStore();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Fetch-on-open, same pattern as loadAlerts() below — keeps the list
  // fresh without a background poll. unreadCount itself stays live
  // regardless (pushed via SSE into the store), this is just the list body.
  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  const recentNotifications = notifications.slice(0, 20);

  // ── Create form state ──
  const [conditionType, setConditionType] = useState<AlertConditionType>("CROSSING");
  const [targetValue, setTargetValue] = useState("");
  const [frequency, setFrequency] = useState<"ONCE" | "EVERY_N_MINUTES">("ONCE");
  const [frequencyMinutes, setFrequencyMinutes] = useState("60");
  const [expiration, setExpiration] = useState("");
  const [messageTemplate, setMessageTemplate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Active alerts list state ──
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [listLoading, setListLoading] = useState(false);

  // ── Resend-verification state ──
  const [resendSent, setResendSent] = useState(false);
  const [resending, setResending] = useState(false);

  function loadAlerts() {
    setListLoading(true);
    listAlerts({ status: "ACTIVE" })
      .then((res) => setAlerts(res.data.data))
      .catch(() => setAlerts([]))
      .finally(() => setListLoading(false));
  }

  // Fetch-on-open, matching TradeToolbar's own pair-search pattern — the
  // panel is short-lived (opens/closes per interaction), so a local
  // useState + fetch-on-open is enough, no global store subscription.
  useEffect(() => {
    if (open) loadAlerts();
  }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pairId || !targetValue.trim()) return;

    setSubmitting(true);
    setSubmitError(null);

    createAlert({
      pairId,
      conditionType,
      targetValue: targetValue.trim(),
      frequency,
      frequencyMinutes: frequency === "EVERY_N_MINUTES" ? parseInt(frequencyMinutes, 10) : undefined,
      expiration: expiration ? new Date(expiration).toISOString() : undefined,
      messageTemplate: messageTemplate.trim() || undefined,
    })
      .then(() => {
        setTargetValue("");
        setMessageTemplate("");
        setExpiration("");
        loadAlerts();
      })
      .catch((err) => {
        setSubmitError(err?.response?.data?.message ?? "Failed to create alert");
      })
      .finally(() => setSubmitting(false));
  }

  function handleCancel(alertId: string) {
    setAlerts((prev) => prev.filter((a) => a.id !== alertId)); // optimistic
    cancelAlert(alertId).catch(() => loadAlerts()); // reconcile on failure
  }

  function handleResend() {
    setResending(true);
    resendVerification()
      .then(() => setResendSent(true))
      .catch(() => {})
      .finally(() => setResending(false));
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="tr-tb-icon-btn"
        onClick={() => setOpen((v) => !v)}
        title="Alerts"
        aria-label="Alerts"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ position: "relative" }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" />
        </svg>
        {unreadCount > 0 && (
          <span style={{
            position: "absolute", top: -3, right: -3,
            background: "#ff3b3b", color: "#fff", fontSize: 9, fontWeight: 700,
            borderRadius: "50%", width: 14, height: 14,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Space Mono', monospace", lineHeight: 1,
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, marginTop: 4,
          background: "#080808",
          border: "1px solid rgba(0,255,65,0.16)",
          borderRadius: 2,
          boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
          zIndex: 50, width: 320, padding: 0,
          maxHeight: 480, overflow: "hidden",
          display: "flex", flexDirection: "column",
          fontFamily: "'Space Mono', monospace",
        }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setActiveTab("alerts")}
              style={tabButtonStyle(activeTab === "alerts")}
            >
              Price Alerts
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("notifications")}
              style={tabButtonStyle(activeTab === "notifications")}
            >
              Notifications{unreadCount > 0 ? ` (${unreadCount})` : ""}
            </button>
          </div>

          <div style={{ overflowY: "auto" }}>
          {activeTab === "notifications" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px 4px" }}>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>NOTIFICATIONS</span>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => markAllNotificationsRead()}
                    style={{ background: "transparent", border: "none", color: "#00ff41", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {recentNotifications.length === 0 ? (
                <div style={{ padding: "16px 12px", fontSize: 10.5, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>
                  No notifications
                </div>
              ) : (
                recentNotifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => { if (!n.read_at) markNotificationRead(n.id); }}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 8, width: "100%",
                      textAlign: "left", padding: "8px 12px",
                      background: n.read_at ? "transparent" : "rgba(0,255,65,0.04)",
                      border: "none", borderBottom: "1px solid rgba(255,255,255,0.05)",
                      cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 1, width: 12, textAlign: "center", flexShrink: 0 }}>
                      {NOTIF_KIND_ICONS[n.kind] ?? "i"}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 11, color: n.read_at ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.9)" }}>
                        {n.title}
                      </span>
                      {n.body && (
                        <span style={{ display: "block", fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {n.body}
                        </span>
                      )}
                      <span style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 3 }}>
                        {new Date(n.created_at).toLocaleString()}
                      </span>
                    </span>
                    {!n.read_at && (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00ff41", marginTop: 4, flexShrink: 0 }} />
                    )}
                  </button>
                ))
              )}
            </>
          ) : (
          <>
          <div style={{ padding: "6px 12px 4px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>
            NEW ALERT — {pairSymbol ?? "—"}
          </div>

          {user && user.emailVerified === false && (
            <div style={{
              margin: "0 12px 8px", padding: "8px 10px",
              background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.3)",
              borderRadius: 2, fontSize: 10.5, color: "rgba(234,179,8,0.9)", lineHeight: 1.5,
            }}>
              You'll need to verify your email before this alert can notify you.
              {resendSent ? (
                <div style={{ marginTop: 4, color: "rgba(255,255,255,0.5)" }}>Verification email sent.</div>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending}
                  style={{
                    display: "block", marginTop: 4, padding: 0,
                    background: "transparent", border: "none",
                    color: "#00ff41", fontSize: 10.5, cursor: resending ? "default" : "pointer",
                    textDecoration: "underline", fontFamily: "inherit",
                  }}
                >
                  {resending ? "Sending..." : "Resend verification email"}
                </button>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            <select
              value={conditionType}
              onChange={(e) => setConditionType(e.target.value as AlertConditionType)}
              style={selectStyle}
            >
              {CONDITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            <input
              type="text"
              inputMode="decimal"
              placeholder="Value (price)"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              style={inputStyle}
            />

            <div style={{ display: "flex", gap: 6 }}>
              <label style={radioLabelStyle}>
                <input type="radio" checked={frequency === "ONCE"} onChange={() => setFrequency("ONCE")} />
                Once
              </label>
              <label style={radioLabelStyle}>
                <input type="radio" checked={frequency === "EVERY_N_MINUTES"} onChange={() => setFrequency("EVERY_N_MINUTES")} />
                Every N minutes
              </label>
            </div>

            {frequency === "EVERY_N_MINUTES" && (
              <input
                type="number"
                min={1}
                placeholder="Minutes"
                value={frequencyMinutes}
                onChange={(e) => setFrequencyMinutes(e.target.value)}
                style={inputStyle}
              />
            )}

            <input
              type="datetime-local"
              value={expiration}
              onChange={(e) => setExpiration(e.target.value)}
              style={inputStyle}
              title="Expiration (optional)"
            />

            <textarea
              placeholder="Message (optional)"
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              rows={2}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />

            <label style={{ ...radioLabelStyle, opacity: 0.6 }}>
              <input type="checkbox" checked disabled />
              Email
            </label>

            {submitError && (
              <div style={{ fontSize: 10, color: "#ff4d4d" }}>{submitError}</div>
            )}

            <button
              type="submit"
              disabled={submitting || !pairId || !targetValue.trim()}
              style={{
                padding: "6px 0", fontSize: 11, fontWeight: 700, letterSpacing: 1,
                background: "#00ff41", color: "#000", border: "none", borderRadius: 2,
                cursor: submitting ? "default" : "pointer", opacity: submitting || !pairId || !targetValue.trim() ? 0.5 : 1,
              }}
            >
              {submitting ? "CREATING..." : "CREATE ALERT"}
            </button>
          </form>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "2px 0" }} />

          <div style={{ padding: "6px 12px 4px", fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 3 }}>
            ACTIVE ALERTS
          </div>

          {listLoading ? (
            <div style={{ padding: "8px 12px", fontSize: 10.5, color: "rgba(255,255,255,0.3)" }}>Loading...</div>
          ) : alerts.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 10.5, color: "rgba(255,255,255,0.3)" }}>No active alerts</div>
          ) : (
            alerts.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 8, padding: "5px 12px",
                }}
              >
                <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.75)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {CONDITION_LABELS[a.condition_type]} {a.target_value}
                  {a.frequency === "EVERY_N_MINUTES" ? ` · ${a.frequency_minutes}m` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => handleCancel(a.id)}
                  title="Cancel alert"
                  aria-label="Cancel alert"
                  style={{
                    background: "transparent", border: "none", color: "rgba(255,255,255,0.4)",
                    cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, flexShrink: 0,
                  }}
                >
                  &times;
                </button>
              </div>
            ))
          )}
          </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "8px 0", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase",
    fontFamily: "'Space Mono', monospace", fontWeight: 700, cursor: "pointer",
    background: active ? "rgba(0,255,65,0.06)" : "transparent",
    color: active ? "#00ff41" : "rgba(255,255,255,0.4)",
    border: "none", borderBottom: active ? "2px solid #00ff41" : "2px solid transparent",
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%", height: 28, boxSizing: "border-box",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 2, padding: "0 8px",
  fontFamily: "'Space Mono', monospace", fontSize: 11,
  color: "rgba(255,255,255,0.88)", outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const radioLabelStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  fontSize: 10.5, color: "rgba(255,255,255,0.7)",
  cursor: "pointer", flex: 1,
};
