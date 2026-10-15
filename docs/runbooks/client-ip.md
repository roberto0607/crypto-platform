# Runbook: real client IP behind Cloudflare + Railway

Requests reach the API as **visitor → Cloudflare → Railway edge → Railway internal proxy → API**.
Rate limits, the login lockout, Quick Call's per-IP limit and `audit_log.ip` all use
`clientIp(req)` (`apps/api/src/http/clientIp.ts`), which works like this:

1. Fastify trusts `TRUST_PROXY_HOPS` hops of `X-Forwarded-For` (default **2** in production:
   Railway's internal proxy and its edge). `req.ip` is then `XFF[-2]`, the address that
   connected to Railway's edge.
2. If that address is inside Cloudflare's published ranges, the request really came through
   Cloudflare, so `CF-Connecting-IP` (the visitor) is used.
3. Otherwise `req.ip` is used as-is. A request sent straight to the `*.up.railway.app` domain with
   a forged `CF-Connecting-IP` therefore gets keyed on its own address.

`X-Real-IP` is not used. Railway sets it with rules it doesn't document (it already maps
Cloudflare traffic to the visitor, so Railway runs its own Cloudflare trust logic). We'd be
depending on behaviour we can't test or pin, and it gives no answer the XFF + range check doesn't.

### How the layout was measured (2026-10-14)

A temporary `/debug/client-ip` route (PR #210, removed in the follow-up) logged these two requests
from the same visitor, `131.125.17.17`:

| | Via Cloudflare (`api.playtradr.com`) | Direct (`*.up.railway.app`), forged `XFF: 104.22.195.131` + `CF-Connecting-IP: 6.6.6.6` |
|---|---|---|
| TCP peer | `100.64.0.2` | `100.64.0.2` |
| `X-Forwarded-For` | `104.22.195.131, 152.233.47.68` | `131.125.17.17, 152.233.47.68` |
| `CF-Connecting-IP` | `131.125.17.17` | `6.6.6.6` (passed through) |
| `X-Real-IP` | `131.125.17.17` | `131.125.17.17` |
| Resolved at 1 hop | `152.233.47.68` (wrong) | `152.233.47.68` (wrong) |
| Resolved at 2 hops | `131.125.17.17` | `131.125.17.17` |

Railway's edge (`152.233.47.68`, `x-railway-edge: jfk1`) **replaced** the forged
`X-Forwarded-For`. `XFF[-2]` is right either way: if the edge appended instead, the forged entry
would sit further left, where 2 hops never look. Both requests are replayed verbatim in
`apps/api/src/http/__tests__/clientIp.test.ts`.

Only the `jfk1` edge was sampled. If another Railway edge region ever added or dropped a layer,
the table below shows it as a private or Railway address in `audit_log.ip`.

History: prod first ran on 0 hops (variable misspelled `TRSUT_PROXY_HOPS`), so `req.ip` was
Railway's internal proxy. It then ran on 1 hop, so `req.ip` was Railway's edge. Both put every
visitor into a handful of shared rate-limit buckets and login-lockout counters.

## Verify after deploy

1. **Boot log.** In the API service's deploy logs, find `client_ip_resolution`. Expect
   `trustProxyHops: 2` and `cloudflareRangeCheck: "on"`. If `trustProxyHopsSource` reads `env`,
   a `TRUST_PROXY_HOPS` variable on Railway overrides the default. Set it to `2` or delete it.
   A `misspelled_env_var` warning means `TRSUT_PROXY_HOPS` still exists. Delete it. The warning
   names the variable and never prints its value.
2. **Your IP as Cloudflare sees it.** In the browser you use for TRADR, open
   `https://api.playtradr.com/cdn-cgi/trace` and note the `ip=` line. It may be IPv6.
3. **Log in** to playtradr.com.
4. **Check the audit log.** Get the connection string as described in CLAUDE.md → Database, then:

   ```sql
   SELECT created_at, ip
   FROM audit_log
   WHERE action = 'auth.login'
     AND actor_user_id = '<your user id>'
   ORDER BY created_at DESC
   LIMIT 3;
   ```

   The newest row's `ip` must equal the `ip=` from step 2.

| `ip` you see | Meaning | Action |
|---|---|---|
| Your IP | Working | Done |
| `10.x`, `100.64.x`–`100.127.x`, or another private address | Still on 0 hops | Check that the boot log says `trustProxyHops: 2`. Check that `TRUST_PROXY_HOPS` isn't set to `0` |
| `152.233.x` or another non-Cloudflare, non-you public address | Still on 1 hop: that's Railway's edge | Same check: boot log must say `trustProxyHops: 2` |
| A Cloudflare address (e.g. `104.16.x`, `172.64.x`, `162.158.x`, `2a06:98c0:…`) | Hops are right but the Cloudflare check didn't apply | Run `pnpm cf-ips:check` (ranges may have drifted). Confirm `cloudflareRangeCheck: "on"` |

**Emergency off-switch:** set `TRUST_CLOUDFLARE_CONNECTING_IP=false` and redeploy. Keying falls
back to the edge address. That's coarse, but it can't be spoofed.

## Refresh the Cloudflare IP ranges

Cloudflare rarely changes these. Check them every few months, or whenever the table above
shows a Cloudflare address.

```bash
cd apps/api
pnpm cf-ips:check   # read-only; exit 0 = up to date, exit 1 = drift (prints +/- and the live lists)
```

On drift, paste the printed arrays into `apps/api/src/http/cloudflareRanges.ts`, update the
"fetched" dates, run `npx vitest run src/http/__tests__/clientIp.test.ts`, and ship it as its own PR.

The sources are https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6.

## Known gap: remove the public `*.up.railway.app` domain

The range check proves a request came **through Cloudflare**, not through **our** Cloudflare
zone. Anything running on Cloudflare's network (another customer's Worker, for example) connects
from a Cloudflare address. If it sends requests to `crypto-platform-production-691d.up.railway.app`,
the API sees a Cloudflare `req.ip` and trusts whatever `CF-Connecting-IP` that Worker set. That
lets it mint unlimited rate-limit buckets and write any IP it likes into `audit_log`.

**Fix:** remove the Railway-generated public domain from the `crypto-platform` service
(Railway → service → Settings → Networking → Public Networking → delete the `*.up.railway.app`
domain; keep the `api.playtradr.com` custom domain). After that, the only hostname that reaches the
API is `api.playtradr.com`, which is proxied by our own zone. Cloudflare sets `CF-Connecting-IP`
itself there.

Check these before removing it:

1. **Cloudflare DNS.** The `api.playtradr.com` CNAME must point at the target Railway gave for the
   custom domain, **not** at `crypto-platform-production-691d.up.railway.app`. If it points at the
   legacy host, deleting the domain takes the API down.
2. **Web bundle.** `gallant-reprieve`'s `VITE_API_BASE` must be `https://api.playtradr.com`. Check
   the live bundle, not just the variable:
   `curl -s https://playtradr.com/ | grep -o '/assets/index-[^"]*\.js'`, then fetch that file and
   grep it for `up.railway.app`.
3. **`apps/web/index.html`.** The `preconnect` and `dns-prefetch` hints point at the legacy API
   host. They don't break anything when it's gone (the hint fails silently), but point them at
   `https://api.playtradr.com`.
4. **Anything outside the repo:** uptime monitors, k6 `BASE_URL`s, saved curl or Postman
   requests, scripts on other machines. Railway's own healthcheck uses the internal network, so
   removing the domain doesn't affect it.

Leave the **web** service's `gallant-reprieve-production.up.railway.app` domain alone. It's a
separate service, and `apps/web/nginx.conf` 301s it to playtradr.com for old links.

**Verify after removal:** `curl -sI https://crypto-platform-production-691d.up.railway.app/pairs`
should fail (Railway 404 "Application not found"), and `https://api.playtradr.com/pairs` should
return 200. Also `curl` the custom domain's CNAME target directly. It should not serve the API
either; if it does, it's another direct path that bypasses our zone.

The complete fix would be Cloudflare **Authenticated Origin Pulls** (the origin accepts only
Cloudflare's client certificate). Railway terminates TLS at its edge, so the API can't check the
client certificate itself. Treat that as unavailable unless Railway adds mTLS. Until the domain is
removed, the gap is acceptable because every consumer of the client IP is a fairness or forensics
control, not an auth boundary.
