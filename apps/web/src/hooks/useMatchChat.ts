import { useCallback, useEffect, useState } from "react";
import type { MessageReceivedEvent } from "@/types/api";

/**
 * Match chat's open/unread state. The panel owns its own log: it mounts on the
 * first open and stays mounted, so the log survives closing it. A new match
 * starts clean. A "match" message can only be for this match: one at a time.
 */
export function useMatchChat(matchId: string | null) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    setOpen(false);
    setEverOpened(false);
    setUnread(0);
  }, [matchId]);

  useEffect(() => {
    if (!matchId) return;
    const handler = (e: Event) => {
      const d = (e as CustomEvent<MessageReceivedEvent>).detail;
      if (d?.conversationType === "match" && !open) setUnread((n) => n + 1);
    };
    window.addEventListener("sse:message.received", handler);
    return () => window.removeEventListener("sse:message.received", handler);
  }, [matchId, open]);

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was) {
        setUnread(0);
        setEverOpened(true);
      }
      return !was;
    });
  }, []);

  return { open, everOpened, unread, toggle, close: useCallback(() => setOpen(false), []) };
}
