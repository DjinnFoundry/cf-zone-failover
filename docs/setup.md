# Setting up the reserve

What has to exist before the guard can do anything. The names below are placeholders:

| Placeholder | What |
| --- | --- |
| `example.com`, `www.example.com` | your public hostnames, on the **primary zone** |
| `origin.example.com` | Custom Domain of your main Worker on the primary zone; the proxy forwards to it |
| `reserve.example` | the **reserve zone**, served from IPs that are not blocked |
| `fallback.reserve.example` | the reserve zone's fallback origin; the CNAME target during a block |
| `reserve-check.example.com` | a hostname permanently routed through the reserve, used as health check |

All the API calls use:

```bash
export T=<token with the permissions of the step>
CF=https://api.cloudflare.com/client/v4
```

## 1. Pick the reserve zone

Its IPs must not be on the blocklists. Look at the history of the source you will use (for hayahora.futbol, `https://hayahora.futbol/estado/data.json`) before choosing. In October 2026 new zones in new accounts were landing in the same ranges as the heavily blocked ones, so an older zone you already own is a better bet than a fresh one.

The proxy is routed with a wildcard (`*/*`) on the reserve zone. That is only acceptable if the reserve zone serves nothing else.

## 2. Cloudflare for SaaS on the reserve zone

1. Enable it in the dashboard: SSL/TLS → Custom Hostnames. The first 100 hostnames are free.
2. Create the fallback origin record, proxied: `AAAA fallback.reserve.example 100::`.
3. Set `fallback.reserve.example` as the fallback origin and wait for it to be `active`.

## 3. The reserve proxy Worker

Deploy the proxy (README, step 3) on the reserve zone's account, with routes `*/*` and `fallback.reserve.example/*` on the reserve zone, and the secret:

```bash
S=$(openssl rand -hex 32)
printf '%s' "$S" | npx wrangler secret put FALLBACK_PROXY_SECRET --config proxy/wrangler.jsonc
printf '%s' "$S" | npx wrangler secret put FALLBACK_PROXY_SECRET --config site/wrangler.jsonc
# ...and in any other Worker that calls fromFallbackProxy. Keep a copy in your password manager.
unset S
```

While the secrets differ, the reserve answers 404.

## 4. The origin Custom Domain

Add `origin.example.com` as a Custom Domain of the main Worker, and call `fromFallbackProxy` first thing in its `fetch` (README, step 2). If other Workers serve parts of the site through routes, add the same routes on `origin.example.com` and call `fromFallbackProxy` there too.

A new Custom Domain takes about 15 minutes to answer requests that come from another account. Until then some proxied requests fail with 530 (error 1016) even though it answers from outside.

## 5. Custom hostnames for the public names

For each public hostname, create a custom hostname on the reserve zone with **TXT** validation:

```bash
curl -s -X POST "$CF/zones/<reserve zone id>/custom_hostnames" -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" --data '{"hostname":"example.com","ssl":{"method":"txt","type":"dv"}}'
```

Put the TXT records it returns (`ssl.validation_records` and `ownership_verification`) in the primary zone, with a comment containing your `dns.marker`, so the guard can replace them on renewal. Use TXT and not a delegated `_acme-challenge` CNAME: on the apex, a CNAME there collides with the hidden TXT records the primary zone uses to renew its own certificate.

The hostnames stay `pending` until the first block: that is expected. The certificate should become `active` once the TXT records are seen.

## 6. The health-check hostname

Create `reserve-check.example.com` as a custom hostname too, and a DNS-only CNAME `reserve-check.example.com → fallback.reserve.example` in the primary zone. This one is always routed through the reserve, so a 200 from it proves the whole chain. It can use a delegated `_acme-challenge` CNAME, since that subdomain has no certificate of its own.

```bash
curl -sI https://reserve-check.example.com/        # 200: the app served by the reserve
curl -sI https://origin.example.com/               # 404: no signature, nothing served
```

## 7. The guard

1. A KV namespace, Email Routing on a zone you own with verified destinations, and the two tokens of the README table, each owned by the account it touches.
2. Deploy it in `GUARD_MODE: "observe"` and watch one match day: it mails what it would have done.
3. Rehearse outside a match: activate and deactivate once by hand (below) or set the mode to `auto` with a test blocklist, and check every critical path of your site through the reserve.
4. Switch to `auto`.

## Doing it by hand

What the guard does, if you need to without it.

**Activate.** Delete the production Custom Domains of the public hostnames (not `origin.example.com`), then create, for each, `CNAME <name> → fallback.reserve.example`, DNS only, TTL 60. On the apex Cloudflare flattens the CNAME and it coexists with MX and TXT records. The custom hostnames become `active` within a couple of minutes.

**Deactivate.** Delete those CNAMEs and recreate the Custom Domains:

```bash
curl -s -X PUT "$CF/accounts/<account id>/workers/domains" -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  --data '{"hostname":"example.com","service":"<worker>","zone_id":"<primary zone id>","environment":"production"}'
```

**After every block.** When the public names stop pointing at the reserve, Cloudflare marks their custom hostnames `moved` and deletes them after 7 days. Reactivate them (`PATCH .../custom_hostnames/<id>` with `{"ssl":{"method":"txt","type":"dv"}}`) and put the new TXT records in place. The guard does this on its own in `auto` mode.

## Known risks

- **The IPs the blocked country sees can change** without the guard noticing. Re-check them from a line in that country and update `seedIps`.
- **The reserve zone can get blocked too.** The guard alerts and does nothing.
- **Deploying the main Worker with the reserve active fails**: it tries to recreate Custom Domains on names that have a CNAME.
- **Cost:** with the reserve active each request is two Worker invocations. The proxy itself uses well under 1 ms of CPU.
- **Monitoring from inside the blocked ISP stays blind** even when the reserve works. Probe the health-check hostname too.
