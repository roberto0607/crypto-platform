import { config } from "../config";

export const REFRESH_COOKIE_NAME = "refresh_token";

// In production, frontend and API are on separate Railway subdomains (cross-origin).
// sameSite: "none" + secure: true allows the browser to send the cookie on
// cross-origin POST requests (required for /auth/refresh token rotation).
// In dev, the Vite proxy makes everything same-origin so "lax" is fine.
//
// Known issue: two browsers/tabs logged in as the same user can trigger
// concurrent refresh rotations. The second tab revokes the first tab's token,
// causing token-reuse detection which revokes the entire family and logs both
// out. This is expected behavior for the refresh token rotation security model.
const baseOptions = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: (config.isProd ? "none" : "lax") as "none" | "lax",
  path: "/",
};

export function refreshCookieSetOptions(expires: Date) {
  return { ...baseOptions, expires };
}

export const refreshCookieClearOptions = baseOptions;
