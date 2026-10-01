/**
 * useNotifyOnLive — NOTIFY ME on the idle panel. There is no server-side
 * notification channel for anonymous visitors, so this is a browser
 * notification fired while the page is open, when a match goes live.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeaturedMatch } from "@/api/endpoints/landing";

const STORAGE_KEY = "tradr_notify_live";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Private mode etc. — the toggle still works for this visit.
  }
}

export function useNotifyOnLive(featured: FeaturedMatch | null | undefined) {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [enabled, setEnabled] = useState(() => supported && read() && Notification.permission === "granted");
  const prev = useRef(featured);

  const toggle = useCallback(() => {
    if (enabled) {
      setEnabled(false);
      write(false);
      return;
    }
    void Notification.requestPermission().then((perm) => {
      const on = perm === "granted";
      setEnabled(on);
      write(on);
    });
  }, [enabled]);

  useEffect(() => {
    const was = prev.current;
    prev.current = featured;
    if (!enabled || was !== null || !featured) return;
    const who = [featured.challenger.handle, featured.opponent.handle].filter(Boolean).join(" vs ");
    new Notification("A 1v1 match just went live on TRADR", { body: who || undefined, tag: "tradr-live" });
  }, [featured, enabled]);

  return { supported, enabled, toggle };
}
