# Runbook: real client IP behind Cloudflare + Railway

Requests reach the API as **visitor → Cloudflare → Railway edge → API**. Rate limits, the login
lockout, Quick Call's per-IP limit and `audit_log.ip` all use `clientIp(req)`
(`apps/api/src/http/clientIp.ts`), which works like this:

1. Fastify trusts `TRUST_PROXY_HOPS` hops of `X-Forwarded-For` (default **1** in production:
   Railway's edge). `req.ip` is then the address Railway's edge saw.
2. If that address is inside Cloudflare's published ranges, the request really came through
   Cloudflare, so `CF-Connecting-IP` (the visitor) is used.
3. Otherwise `req.ip` is used as-is. A request sent straight to the `*.up.railway.app` domain with
   a forged `CF-Connecting-IP` therefore gets keyed on its own address.

Before this fix, prod had the variable misspelled as `TRSUT_PROXY_HOPS`, so the API ran on
0 hops. `req.ip` was Railway's proxy, and every anonymous visitor shared one rate-limit bucket and
one login-lockout counter.

## Verify after deploy

1. **Boot log.** In the API service's deploy logs, find `client_ip_resolution`. Expect
   `trustProxyHops: 1` and `cloudflareRangeCheck: "on"`. `trustProxyHopsSource` reads `default`
   until the Railway variable is renamed, and `env` after. While the old name still exists you'll
   also see a `misspelled_env_var` warning. It names the variable and never prints its value.
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
| `10.x`, `100.64.x`–`100.127.x`, or another private address | Still on 0 hops | Check that the boot log says `trustProxyHops: 1`. Check that `TRUST_PROXY_HOPS` isn't set to `0` |
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

## Known gap

The range check proves a request came **through Cloudflare**, not through **our** Cloudflare
zone, so another Cloudflare customer's Worker could reach the origin. The full fix is Cloudflare
**Authenticated Origin Pulls**, where the origin only accepts Cloudflare's client certificate. That's
a dashboard and origin-TLS change, tracked as a follow-up. It's acceptable for now because every
consumer of the client IP is a fairness or forensics control, not an auth boundary.
