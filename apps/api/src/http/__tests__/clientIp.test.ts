import { describe, it, expect } from "vitest";
import { isCloudflareIp, resolveClientIp } from "../clientIp";

// Unit tests for the real-client-IP resolution (QA 2026-10-11 P1: normal
// browsing hit 429 because every visitor shared the proxy's address).

const CF_EDGE_V4 = "104.16.1.1"; // 104.16.0.0/13
const CF_EDGE_V6 = "2606:4700::6810:101"; // 2606:4700::/32
const NOT_CF = "203.0.113.7"; // TEST-NET-3
const CLIENT = "198.51.100.20"; // TEST-NET-2

describe("isCloudflareIp", () => {
  it("matches addresses inside the published v4 and v6 ranges", () => {
    expect(isCloudflareIp(CF_EDGE_V4)).toBe(true);
    expect(isCloudflareIp("172.64.0.1")).toBe(true);
    expect(isCloudflareIp(CF_EDGE_V6)).toBe(true);
  });

  it("matches an IPv4-mapped IPv6 Cloudflare address", () => {
    expect(isCloudflareIp(`::ffff:${CF_EDGE_V4}`)).toBe(true);
  });

  it("rejects non-Cloudflare, private, loopback and garbage input", () => {
    expect(isCloudflareIp(NOT_CF)).toBe(false);
    expect(isCloudflareIp("10.0.0.9")).toBe(false);
    expect(isCloudflareIp("127.0.0.1")).toBe(false);
    expect(isCloudflareIp("::1")).toBe(false);
    expect(isCloudflareIp("not-an-ip")).toBe(false);
    expect(isCloudflareIp("")).toBe(false);
  });
});

describe("resolveClientIp", () => {
  it("uses CF-Connecting-IP when the edge is a Cloudflare address", () => {
    expect(resolveClientIp(CF_EDGE_V4, CLIENT, true)).toBe(CLIENT);
    expect(resolveClientIp(CF_EDGE_V6, "2001:db8::42", true)).toBe("2001:db8::42");
  });

  it("ignores a spoofed CF-Connecting-IP from a non-Cloudflare source", () => {
    // Direct hit on *.up.railway.app with a forged header.
    expect(resolveClientIp(NOT_CF, CLIENT, true)).toBe(NOT_CF);
    expect(resolveClientIp("10.0.0.9", CLIENT, true)).toBe("10.0.0.9");
  });

  it("falls back to the edge when the header is missing, repeated or not an IP", () => {
    expect(resolveClientIp(CF_EDGE_V4, undefined, true)).toBe(CF_EDGE_V4);
    expect(resolveClientIp(CF_EDGE_V4, [CLIENT, NOT_CF], true)).toBe(CF_EDGE_V4);
    expect(resolveClientIp(CF_EDGE_V4, "1.2.3.4, 5.6.7.8", true)).toBe(CF_EDGE_V4);
    expect(resolveClientIp(CF_EDGE_V4, "evil", true)).toBe(CF_EDGE_V4);
  });

  it("never honors the header when Cloudflare trust is switched off", () => {
    expect(resolveClientIp(CF_EDGE_V4, CLIENT, false)).toBe(CF_EDGE_V4);
  });

  it("normalizes IPv4-mapped addresses", () => {
    expect(resolveClientIp(`::ffff:${NOT_CF}`, undefined, true)).toBe(NOT_CF);
    expect(resolveClientIp(CF_EDGE_V4, `::ffff:${CLIENT}`, true)).toBe(CLIENT);
  });
});
