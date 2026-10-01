/**
 * Fastify `trustProxy` option derived from TRUST_PROXY_HOPS.
 *
 * Fastify's runtime has always accepted a number N ("trust N hops") and
 * compiles it to `(addr, hop) => hop < N` (lib/request.js getTrustProxyFn).
 * Its *types*, however, dropped `number` from the accepted union in later
 * 5.x releases, so passing `config.trustProxyHops` directly stopped
 * compiling once the Docker build resolved a newer fastify. Returning the
 * equivalent TrustProxyFunction keeps the exact runtime behavior and
 * type-checks on every 5.x version.
 *
 *   hops <= 0 → false (req.ip = TCP peer; today's default)
 *   hops = N  → trust the N closest hops in X-Forwarded-For
 */
export type TrustProxyFn = (address: string, hop: number) => boolean;

export function trustProxyOption(hops: number): false | TrustProxyFn {
  if (!(hops > 0)) return false;
  return (_address, hop) => hop < hops;
}
