# cf-zone-failover

Keep a site on Cloudflare Workers reachable when ISPs block the IPs your zone is served from.

Since February 2025 the main Spanish ISPs (Movistar, Orange, Vodafone, DIGI, Masmovil) block, during LaLiga football matches, the Cloudflare IPs that LaLiga reports as carrying pirated streams. Those are shared IPs. Thousands of unrelated sites go dark on match days, with no error page, for every customer of those ISPs. Cloudflare does not reassign a zone's IPs on any plan, new zones land in the same ranges, and a Worker has no origin server you could expose instead.

This package is what [ZetaRead](https://zetaread.com) built to get through it ([write-up](https://dgilperez.com/writing/cloudflare-workers-laliga-blocks)). It has two parts:

- **A signed reserve proxy.** A second zone, served from other IPs, holds your public hostnames as Cloudflare for SaaS custom hostnames. Its Worker forwards each request, signed, to a Custom Domain of your main Worker. The origin checks the signature and rewrites the request to its public host, so the app does not notice.
- **A guard.** A cron Worker reads per-ISP blocklists ([hayahora.futbol](https://hayahora.futbol) by default), and when one of your IPs is blocked it points your public hostnames at the reserve. When the block is over it points them back. Between blocks it keeps the reserve's custom hostnames and certificates valid, and it mails you each time it acts or cannot.

```
Normal
  browser ──► example.com (zone IPs) ──► main Worker

During a block
  browser ──► example.com  CNAME, DNS only ─► fallback.reserve.example (other IPs)
                                               │  custom hostname of the reserve zone
                                               ▼
                                         reserve proxy Worker
                                               │  signed fetch, from inside Cloudflare
                                               ▼
                                         origin.example.com ──► main Worker
                                                               (undoes the hand-off)
```

Status: ZetaRead runs it in production. The reserve has been through a real block, switched by hand; the guard has passed a full rehearsal outside a match but not yet a real block. Read [What it does not do](#what-it-does-not-do) before you rely on it.

## Requirements

- Your site is a Cloudflare Worker served through **Custom Domains** on a zone (the *primary zone*).
- A **second zone** whose IPs are not blocked (the *reserve zone*). It can be in another account. Check it in the blocklist history first: a recently created zone is likely to share your zone's ranges.
- **Cloudflare for SaaS** on the reserve zone (custom hostnames; the first 100 are free).
- Workers KV and, for the alerts, **Email Routing** with verified destinations on a zone you own.

## Install

```bash
pnpm add github:DjinnFoundry/cf-zone-failover#v0.1.0
```

The compiled JavaScript is committed in `dist/`, so no build step runs on install.

## Use

### 1. Shared configuration

```ts
// failover.config.ts
import { createSigning, type GuardConfig } from 'cf-zone-failover';

export const signing = createSigning({
  originHost: 'origin.example.com',
  publicHosts: ['example.com', 'www.example.com'],
  // A permanent hostname through the reserve, used as its health check.
  testHostPattern: /^reserve-check\.example\.com$/,
});

export const guardConfig: GuardConfig = {
  primary: {
    accountId: '<primary account id>',
    zoneId: '<primary zone id>',
    worker: 'my-site',
    publicHosts: ['example.com', 'www.example.com'],
    probeHost: 'origin.example.com',
  },
  reserve: {
    zoneId: '<reserve zone id>',
    fallbackHost: 'fallback.reserve.example',
    healthUrl: 'https://reserve-check.example.com/',
  },
  // What the blocked country sees for your zone: see "Seed IPs" below.
  seedIps: { zone: ['<zone ip>', '<zone ip>'], reserve: ['<reserve ip>', '<reserve ip>'] },
  locale: 'en', // or 'es'
};
```

### 2. The origin: undo the hand-off first

```ts
// main Worker
import { signing } from './failover.config';

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext) {
    const proxied = signing.fromFallbackProxy(incoming, env.FALLBACK_PROXY_SECRET);
    if (proxied instanceof Response) return proxied; // 404: origin host without a valid signature
    const request = proxied ?? incoming;
    // ...your app, with `request`
  },
};
```

`fromFallbackProxy` rewrites the URL **and the `Host` header**. Frameworks such as OpenNext build the request URL from `Host`; left as the origin's, every middleware rewrite looks external and the Worker fetches itself over the internet.

### 3. The reserve proxy Worker

```ts
import { createFallbackProxy } from 'cf-zone-failover';
import { signing } from './failover.config';

export default createFallbackProxy(signing);
```

Route it on the reserve zone with `*/*` and `fallback.reserve.example/*`. It needs the secret `FALLBACK_PROXY_SECRET`, the same value as in the main Worker.

### 4. The guard Worker

```ts
import { createGuardWorker } from 'cf-zone-failover/guard-worker';
import { guardConfig } from './failover.config';

export default createGuardWorker(guardConfig, { label: 'Failover guard', runbook: 'https://…' });
```

A minimal `wrangler.jsonc` is in [`examples/guard.wrangler.jsonc`](examples/guard.wrangler.jsonc). The guard needs:

| Binding | What |
| --- | --- |
| `STATE` | KV namespace for its memory |
| `ALERT_EMAIL` | `send_email` binding, destinations verified in Email Routing |
| `ALERT_FROM`, `ALERT_TO` | sender on a zone with Email Routing; comma-separated recipients |
| `GUARD_MODE` | `auto` acts; anything else only decides and mails, prefixed `[observe]` |
| `CF_TOKEN_PRIMARY` | Workers Scripts Write on the primary account; DNS Write, Workers Routes Write and Zone Read on the primary zone |
| `CF_TOKEN_RESERVE` | SSL and Certificates Write and Zone Read on the reserve zone |

Start in `observe` for a match day or two, then switch to `auto`.

The step-by-step setup (reserve zone, custom hostnames, validation records, tokens) is in [docs/setup.md](docs/setup.md).

## How the guard decides

Every run (a cron of `*/2 * * * *` works well):

1. Reads every ISP list. If any is older than 30 minutes or unreadable, it decides nothing and alerts once.
2. Watches the union of the seed IPs, what the zone resolves to now over DoH, and what it resolved to in the last 24 h.
3. **Activates** as soon as one watched IP is blocked by any ISP, if the reserve health URL answers 200 and the reserve IPs are not blocked. If activation fails halfway it reattaches the Custom Domains.
4. **Goes back** after 30 minutes without a block on any ISP (blocks stop and resume within a match), or at once if the reserve is the one blocked.
5. Outside a block, **maintains the reserve**: reactivates custom hostnames in `moved` (Cloudflare deletes them after 7 days otherwise), recreates missing ones, and puts the validation TXT records Cloudflare asks for in the primary zone.

Every action and every problem is mailed; a repeated problem at most once every 6 hours; three failed runs in a row too. All the timings are configurable.

## Seed IPs

Cloudflare answers a zone's A records according to where the resolver is, and ignores `edns_client_subnet`. The cron does not run in the blocked country, so it cannot see by itself which IPs that country gets. Put them in `seedIps`, checked from a line in that country:

```bash
dig +short example.com A @1.1.1.1
dig +short example.com A @8.8.8.8
```

and add any new pair you see later. The guard adds what it resolves, but that is the view from wherever the cron runs.

## What it does not do

- **It notices a block only when the blocklist does.** hayahora.futbol refreshes every few minutes; add the cron interval and DNS propagation (TTL 60) on top.
- **It does not redeploy your Worker.** A deploy while the reserve is active fails, because it tries to recreate Custom Domains on names that now have a CNAME. Do not deploy until the guard reports the way back, and retry any deploy that failed meanwhile.
- **It does not cover IPv6-only or ISP-level DNS blocking**, only IP blocks on the primary zone.
- **It cannot help if the reserve zone gets blocked too.** It alerts and leaves the decision to you.
- **The handover drops in-flight requests** for a few seconds while DNS changes.

## Contributing

This repository is public and must stay free of anyone's real data: domains, emails, IPs, account or zone ids. CI fails on anything that is not documentation data (`example.com`, `.test`, RFC 5737 IPs) or a known public service, scans the history with gitleaks, and only accepts GitHub noreply commit identities. Enable the same check locally before your first commit:

```bash
git config core.hooksPath .githooks   # needs gitleaks installed
```

The hook also reads a private denylist from `~/.config/cf-zone-failover/denylist` (or `PUBLIC_DATA_DENYLIST`), one literal or `/regex/` per line, for names you want blocked without publishing them.

## License

[MIT](LICENSE) © Djinn Foundry
