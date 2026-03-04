import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { getSystemStatus } from "@/api/endpoints/status";

const POLL_INTERVAL_MS = 60_000;

export function useSystemStatusPolling() {
  const setSystemStatus = useAppStore((s) => s.setSystemStatus);

  useEffect(() => {
    const id = setInterval(() => {
      getSystemStatus()
        .then((res) => setSystemStatus(res.data))
        .catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [setSystemStatus]);
}
