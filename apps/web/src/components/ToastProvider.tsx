import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import Toast from "./Toast";

type ToastVariant = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  addToast: (variant: ToastVariant, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

/** Server cancel reasons → user copy (see triggers/positionCloseTriggers.ts, triggerEngine). */
export function triggerCanceledMessage(reason: string | undefined, triggerId: string | undefined): string {
  switch (reason) {
    case "position_closed":
      return "Position closed — its take-profit / stop-loss was canceled.";
    case "no_position":
      return "A stop / take-profit fired with no position left to close — canceled, no order placed.";
    case "oco_sibling_triggered":
      return "The other side of your TP/SL pair fired — this one was canceled.";
    default:
      return `Trigger canceled: ${triggerId?.slice(0, 8) ?? "order"}`;
  }
}

export default function ToastProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = String(++nextId);
      setToasts((prev) => [...prev, { id, variant, message }]);
      const timer = setTimeout(() => removeToast(id), 5000);
      timers.current.set(id, timer);
    },
    [removeToast],
  );

  // Wire SSE custom events to toasts
  useEffect(() => {
    function onTradeCreated(e: Event) {
      const d = (e as CustomEvent).detail;
      addToast(
        "success",
        `Trade filled: ${d.qty} ${d.side} @ $${Number(d.price).toLocaleString()}`,
      );
    }

    function onTriggerFired(e: Event) {
      const d = (e as CustomEvent).detail;
      addToast("warning", `Trigger fired: ${d.triggerKind ?? "trigger"} for ${d.pairId ?? "order"}`);
    }

    function onTriggerCanceled(e: Event) {
      const d = (e as CustomEvent).detail;
      addToast("info", triggerCanceledMessage(d?.reason, d?.triggerId));
    }

    window.addEventListener("sse:trade.created", onTradeCreated);
    window.addEventListener("sse:trigger.fired", onTriggerFired);
    window.addEventListener("sse:trigger.canceled", onTriggerCanceled);

    return () => {
      window.removeEventListener("sse:trade.created", onTradeCreated);
      window.removeEventListener("sse:trigger.fired", onTriggerFired);
      window.removeEventListener("sse:trigger.canceled", onTriggerCanceled);
    };
  }, [addToast]);

  // Cleanup timers on unmount
  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container — top-right, stacked.
          pointer-events-none on the wrapper so it doesn't steal clicks from
          the header's username menu directly underneath. Individual toasts
          re-enable pointer events via the pointer-events-auto wrapper below. */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <Toast
                variant={t.variant}
                message={t.message}
                onClose={() => removeToast(t.id)}
              />
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
