/**
 * Cloudflare's published edge ranges, consumed by http/clientIp.ts.
 * Dependency-free so scripts/checkCloudflareIps.ts can import it without
 * loading config (which requires DATABASE_URL etc.).
 *
 * To refresh: `pnpm cf-ips:check` diffs these against the live lists and
 * exits 1 on drift; paste the printed arrays here. Runbook:
 * docs/runbooks/client-ip.md.
 */

/** https://www.cloudflare.com/ips-v4 — fetched 2026-10-13. */
export const CLOUDFLARE_IPV4_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

/** https://www.cloudflare.com/ips-v6 — fetched 2026-10-13. */
export const CLOUDFLARE_IPV6_RANGES = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;
