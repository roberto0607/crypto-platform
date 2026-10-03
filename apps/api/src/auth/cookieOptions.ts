import { config } from "../config";

export const REFRESH_COOKIE_NAME = "refresh_token";

// SameSite=Lax everywhere. In production the web app (playtradr.com) and the
// API (api.playtradr.com) are different ORIGINS but the same SITE, and
// SameSite only compares sites — so the browser sends this cookie on the
// app's credentialed fetches (POST /auth/refresh included). Dev goes through
// the Vite proxy (same origin).
//
// Do not go back to SameSite=None: it existed only because web and API used to
// be separate *.up.railway.app hosts, and up.railway.app is on the Public
// Suffix List, so those were different sites. Safari treats a cross-site
// cookie as third-party and drops it, which logged users out on every reload.
// The cookie is host-only (no Domain attribute) — scoped to the API host, never
// shared with other playtradr.com subdomains. A web origin that is NOT same-site
// with the API (e.g. the legacy railway host) can't refresh — nginx.conf
// 301-redirects that host to playtradr.com.
//
// Known issue: two browsers/tabs logged in as the same user can trigger
// concurrent refresh rotations. The second tab revokes the first tab's token,
// causing token-reuse detection which revokes the entire family and logs both
// out. This is expected behavior for the refresh token rotation security model.
const baseOptions = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: "lax" as const,
  path: "/",
};

export function refreshCookieSetOptions(expires: Date) {
  return { ...baseOptions, expires };
}

export const refreshCookieClearOptions = baseOptions;
