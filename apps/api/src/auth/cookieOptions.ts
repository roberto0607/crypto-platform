import { config } from "../config";

export const REFRESH_COOKIE_NAME = "refresh_token";

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
