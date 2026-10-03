// Post-login destination from the ?redirect= param that ProtectedRoute /
// AdminRoute / the session-expiry path put on /login. Keeps the original
// path, query (e.g. ?debug=1) and hash, but only ever navigates within this
// app: anything that isn't a same-origin absolute path — "//evil.com",
// "/\evil.com", "https://evil.com", "javascript:" — falls back. /login itself
// also falls back so a stale param can't loop.

const FALLBACK = "/trade";

export function safeRedirectTarget(raw: string | null | undefined, fallback: string = FALLBACK): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  let url: URL;
  try {
    const base = "https://app.invalid";
    url = new URL(raw, base);
    if (url.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return fallback;
  return url.pathname + url.search + url.hash;
}

/** "/login?redirect=<current path+query+hash>" for redirecting away from the current page. */
export function loginUrlFor(location: { pathname: string; search: string; hash?: string }): string {
  const here = location.pathname + location.search + (location.hash ?? "");
  return `/login?redirect=${encodeURIComponent(here)}`;
}
