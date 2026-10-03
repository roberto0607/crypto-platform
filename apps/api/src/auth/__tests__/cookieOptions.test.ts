/**
 * cookieOptions.test.ts — production cookie attributes for the refresh and
 * quick-call anon cookies. Web (playtradr.com) and API (api.playtradr.com)
 * are same-site, so both cookies are SameSite=Lax; Secure + HttpOnly; and
 * host-only (no Domain), so they're never shared with other subdomains.
 * SameSite=None is gone on purpose — see auth/cookieOptions.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

async function loadWith(isProd: boolean) {
  vi.resetModules();
  vi.doMock("../../config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../config")>();
    return { ...actual, config: { ...actual.config, isProd } };
  });
  const auth = await import("../cookieOptions");
  const quickCall = await import("../../quickCall/identity");
  return { auth, quickCall };
}

afterEach(() => {
  vi.doUnmock("../../config");
  vi.resetModules();
});

describe("cookie options", () => {
  it("production: SameSite=Lax, Secure, HttpOnly, host-only, path=/", async () => {
    const { auth, quickCall } = await loadWith(true);
    const expires = new Date(Date.now() + 86_400_000);
    for (const opts of [
      auth.refreshCookieSetOptions(expires),
      auth.refreshCookieClearOptions,
      quickCall.anonCookieOptions,
    ]) {
      expect(opts).toMatchObject({ sameSite: "lax", secure: true, httpOnly: true, path: "/" });
      expect(opts).not.toHaveProperty("domain");
    }
    expect(auth.refreshCookieSetOptions(expires).expires).toBe(expires);
  });

  it("dev: same attributes minus Secure (plain-http localhost)", async () => {
    const { auth, quickCall } = await loadWith(false);
    for (const opts of [auth.refreshCookieClearOptions, quickCall.anonCookieOptions]) {
      expect(opts).toMatchObject({ sameSite: "lax", secure: false, httpOnly: true, path: "/" });
      expect(opts).not.toHaveProperty("domain");
    }
  });
});
