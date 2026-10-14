/**
 * setInterval that skips ticks while the tab is hidden, and catches up with
 * one immediate call when the tab becomes visible again if a tick was missed.
 * Background tabs share the user's 200/min rate-limit budget with the tab
 * they're looking at, so pollers shouldn't spend it on a page nobody sees.
 *
 * Returns a cleanup function (use as a useEffect return).
 */
export function setVisibleInterval(fn: () => void, ms: number): () => void {
  let lastRun = Date.now();
  const run = () => {
    lastRun = Date.now();
    fn();
  };
  const id = setInterval(() => {
    if (document.visibilityState === "visible") run();
  }, ms);
  const onVisibility = () => {
    if (document.visibilityState === "visible" && Date.now() - lastRun >= ms) run();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
