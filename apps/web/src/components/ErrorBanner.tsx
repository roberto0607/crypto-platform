interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
}

export default function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="flex items-center gap-2 rounded border border-red-800 bg-red-900/40 px-4 py-2 text-sm text-red-300">
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-red-400 hover:text-red-200"
        >
          &times;
        </button>
      )}
    </div>
  );
}
