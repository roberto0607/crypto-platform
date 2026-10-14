/**
 * checkCloudflareIps.ts — diff src/http/cloudflareRanges.ts against
 * Cloudflare's live published lists. Read-only; exits 1 on drift.
 *
 *   pnpm cf-ips:check
 *
 * On drift, paste the printed arrays into src/http/cloudflareRanges.ts, update
 * the "fetched" dates, and ship it. Runbook: docs/runbooks/client-ip.md.
 */
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from "../src/http/cloudflareRanges";

async function fetchList(url: string): Promise<string[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.text()).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

function diff(name: string, vendored: readonly string[], live: string[]): boolean {
  const added = live.filter((c) => !vendored.includes(c));
  const removed = vendored.filter((c) => !live.includes(c));
  if (added.length === 0 && removed.length === 0) {
    console.log(`${name}: up to date (${live.length} ranges)`);
    return true;
  }
  console.log(`${name}: DRIFT`);
  for (const c of added) console.log(`  + ${c}`);
  for (const c of removed) console.log(`  - ${c}`);
  console.log(`  live list:\n${JSON.stringify(live, null, 2)}`);
  return false;
}

async function main(): Promise<void> {
  const [v4, v6] = await Promise.all([
    fetchList("https://www.cloudflare.com/ips-v4"),
    fetchList("https://www.cloudflare.com/ips-v6"),
  ]);
  const ok4 = diff("IPv4", CLOUDFLARE_IPV4_RANGES, v4);
  const ok6 = diff("IPv6", CLOUDFLARE_IPV6_RANGES, v6);
  process.exit(ok4 && ok6 ? 0 : 1);
}

main().catch((err) => {
  console.error("cf-ips:check failed:", err);
  process.exit(1);
});
