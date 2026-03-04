import { useAppStore } from "@/stores/appStore";

interface BannerItem {
  color: "red" | "yellow" | "blue";
  message: string;
}

const COLOR_CLASSES: Record<BannerItem["color"], string> = {
  red: "bg-red-600/90 text-white",
  yellow: "bg-yellow-600/90 text-white",
  blue: "bg-blue-600/90 text-white",
};

export default function SystemBanner() {
  const status = useAppStore((s) => s.systemStatus);
  if (!status) return null;

  const banners: BannerItem[] = [];

  if (status.readOnlyMode) {
    banners.push({ color: "red", message: "System is in read-only maintenance mode" });
  }
  if (!status.tradingEnabledGlobal) {
    banners.push({ color: "red", message: "Trading is currently paused" });
  }
  if (status.degraded) {
    banners.push({
      color: "yellow",
      message: status.message || "System is experiencing high load",
    });
  }
  if (status.betaMode) {
    banners.push({ color: "blue", message: "Beta access — invite code required to register" });
  }

  if (banners.length === 0) return null;

  return (
    <>
      {banners.map((b, i) => (
        <div
          key={i}
          className={`${COLOR_CLASSES[b.color]} px-4 py-2 text-center text-sm font-medium`}
        >
          {b.message}
        </div>
      ))}
    </>
  );
}
