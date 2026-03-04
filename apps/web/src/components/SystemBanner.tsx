import { useAppStore } from "@/stores/appStore";

export default function SystemBanner() {
  const status = useAppStore((s) => s.systemStatus);
  if (!status) return null;

  const messages: string[] = [];
  if (!status.tradingEnabledGlobal) messages.push("Trading is paused");
  if (status.readOnlyMode) messages.push("Read-only mode");
  if (status.degraded) messages.push("Degraded performance");
  if (status.message) messages.push(status.message);

  if (messages.length === 0) return null;

  return (
    <div className="bg-yellow-600/90 text-white px-4 py-2 text-center text-sm font-medium">
      {messages.join(" · ")}
    </div>
  );
}
