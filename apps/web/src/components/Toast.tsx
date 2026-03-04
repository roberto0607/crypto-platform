type ToastVariant = "success" | "error" | "info" | "warning";

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: "border-green-700 bg-green-900/70 text-green-300",
  error: "border-red-700 bg-red-900/70 text-red-300",
  info: "border-blue-700 bg-blue-900/70 text-blue-300",
  warning: "border-yellow-700 bg-yellow-900/70 text-yellow-300",
};

interface ToastProps {
  variant?: ToastVariant;
  message: string;
  onClose?: () => void;
}

export default function Toast({
  variant = "info",
  message,
  onClose,
}: ToastProps) {
  return (
    <div
      className={`flex items-center gap-2 rounded border px-4 py-2 text-sm shadow-lg ${VARIANT_CLASSES[variant]}`}
    >
      <span className="flex-1">{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          className="text-current opacity-60 hover:opacity-100"
        >
          &times;
        </button>
      )}
    </div>
  );
}
