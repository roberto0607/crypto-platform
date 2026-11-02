/**
 * An inline confirm step: a message, then CONFIRM / CANCEL. Used where one
 * click would otherwise flip a position (CLOSE & REVERSE, the card's
 * reverse link).
 */
export function ConfirmBox(props: {
  message: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const btn: React.CSSProperties = {
    flex: 1, padding: "7px 0", fontSize: 10, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer",
  };
  return (
    <div role="alertdialog" aria-label="Confirm" data-testid="confirm-box" style={{
      marginTop: 8, padding: "8px 10px", fontSize: 10, lineHeight: 1.45, color: "#fff",
      background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.45)",
    }}>
      <div style={{ marginBottom: 8 }}>{props.message}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" disabled={props.busy} onClick={props.onConfirm}
          style={{ ...btn, background: "rgba(245,158,11,0.2)", border: "1px solid #f59e0b", color: "#f59e0b", opacity: props.busy ? 0.5 : 1 }}>
          {props.confirmLabel}
        </button>
        <button type="button" onClick={props.onCancel}
          style={{ ...btn, background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.6)" }}>
          CANCEL
        </button>
      </div>
    </div>
  );
}
