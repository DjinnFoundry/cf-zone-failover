# cf-zone-failover

Keep sites on Cloudflare reachable when ISPs block the IPs their zones are served from.

Since February 2025 the main Spanish ISPs (Movistar, Orange, Vodafone, DIGI, Masmovil) block, during LaLiga football matches, the Cloudflare IPs that LaLiga reports as carrying pirated streams. Those are shared IPs. Thousands of unrelated sites go dark on match days, with no error page, for every customer of those ISPs. Cloudflare does not reassign a zone's IPs on any plan, new zones land in the same ranges, and a Worker has no origin server you could expose instead.

This package is what [ZetaRead](https://zetaread.com) built to get through it ([write-up](https://dgilperez.com/writing/cloudflare-workers-laliga-blocks)), and now covers several sites from one reserve zone. It has two parts:

- **A reserve proxy.** A second zone, served from other IPs, holds your public hostnames as Cloudflare for SaaS custom hostnames. Its Worker serves each one from a target in the original zone that never moves: a second Custom Domain of a Worker (signed hand-off), the `pages.dev` name of a Pages project, or an origin record of a tunnel or server.
- **A guard.** A cron Worker reads per-ISP blocklists ([hayahora.futbol](https://hayahora.futbol) by default) and decides per zone. When one of a zone's IPs is blocked it points that site's public hostnames at the reserve, and back when the block is over. Between blocks it keeps everything the reserve needs in place, and it mails you each time it acts or cannot.

```
Normal
  browser ──► example.com (zone IPs) ──► Worker / Pages / tunnel

During a block
  browser ──► example.com  CNAME, DNS only ─► fallback.reserve.example (other IPs)
                                               │  custom hostname of the reserve zone
                                               ▼
                                         reserve proxy Worker
                                               │  fetch from inside Cloudflare
                                               ▼
                       origin.example.com (Worker, signed) │ example-docs.pages.dev │ origin record
```

Status: ZetaRead runs it in production, and the guard switched it on its own in a real block (October 2026). Read [What it does not do](#what-it-does-not-do) before you rely on it.

## Requirements

- Your sites are on Cloudflare zones, served by Workers Custom Domains, Pages custom domains or proxied records (tunnels, servers).
- A **reserve zone** whose IPs are not blocked. It can be in another account. Check it in the blocklist history first: a recently created zone is likely to share the blocked ranges.
- **Cloudflare for SaaS** on the reserve zone (custom hostnames; the first 100 are free).
- Workers KV and, for the alerts, **Email Routing** with verified destinations on a zone you own.

## Install

```bash
pnpm add github:DjinnFoundry/cf-zone-failover#v0.2.2
```

The compiled JavaScript is committed in `dist/`, so no build step runs on install.

## Use

### 1. One configuration for every site

```ts
// failover.config.ts
import type { FailoverConfig } from 'cf-zone-failover';

export const config: FailoverConfig = {
  reserve: {
    zoneId: '<reserve zone id>',
    fallbackHost: 'fallback.reserve.example',
    // A permanent hostname through the reserve: a 200 proves the chain.
    healthUrl: 'https://reserve-check.example.com/',
    seedIps: ['<reserve ip>', '<reserve ip>'],
  },
  sites: [
    {
      id: 'shop',
      accountId: '<account id>',
      zoneId: '<zone id>',
      hosts: [
        { name: 'example.com', via: 'worker', worker: 'shop', origin: 'origin.example.com' },
        { name: 'www.example.com', via: 'worker', worker: 'shop', origin: 'origin.example.com' },
      ],
      probeHost: 'origin.example.com',
      testHostPattern: /^reserve-check\.example\.com$/,
      // What the blocked country sees for this zone: see "Seed IPs" below.
      seedIps: ['<zone ip>', '<zone ip>'],
    },
    {
      id: 'docs',
      accountId: '<account id>',
      zoneId: '<zone id>',
      hosts: [
        { name: 'example.org', via: 'pages', project: 'example-docs' },
        { name: 'app.example.org', via: 'origin', origin: 'origin-app.example.org' },
      ],
      probeHost: 'origin-app.example.org',
    },
  ],
  locale: 'en', // or 'es'
};
```

How each kind of host is reached during a block:

| `via` | Served normally by | The proxy fetches | You add |
| --- | --- | --- | --- |
| `worker` | a Worker Custom Domain | `origin`, another Custom Domain of the same Worker, signed | `fromFallbackProxy` in the Worker (step 2) |
| `pages` | a Pages custom domain | `<project>.pages.dev`, or `subdomain` if Pages added a suffix | `accountId` if the project is in another account |
| `origin` | a proxied record (tunnel, server) | `origin`, a proxied record with the same target | the backend must answer to `origin` (for a tunnel, an ingress rule with `httpHostHeader` set to the public name) |

The guard creates the Worker origins, the origin records (copied from the public one) and the probes that are missing, so adding a site is a config entry and a deploy.

### 2. Worker hosts: undo the hand-off first

```ts
// in the Worker that serves example.com
import { createSigning } from 'cf-zone-failover';

const signing = createSigning({
  originHost: 'origin.example.com',
  publicHosts: ['example.com', 'www.example.com'],
});

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext) {
    const proxied = signing.fromFallbackProxy(incoming, env.FALLBACK_PROXY_SECRET);
    if (proxied instanceof Response) return proxied; // 404: origin host without a valid signature
    const request = proxied ?? incoming;
    // ...your app, with `request`
  },
};
```

`fromFallbackProxy` rewrites the URL **and the `Host` header**, and restores the visitor's IP in `cf-connecting-ip`. Frameworks such as OpenNext build the request URL from `Host`; left as the origin's, every middleware rewrite looks external and the Worker fetches itself over the internet.

Pages and origin hosts get no signature: they see the request under their own name, with `x-forwarded-host` set to the public one. The proxy rewrites absolute redirects back to the public name and drops the `x-robots-tag: noindex` that `pages.dev` adds.

### 3. The reserve proxy Worker

```ts
import { createFailoverProxy } from 'cf-zone-failover';
import { config } from './failover.config';

export default createFailoverProxy(config);
```

Route it on the reserve zone with `*/*` and `fallback.reserve.example/*`. Each site with Worker hosts needs its secret, `FALLBACK_SECRET_<ID>` (`FALLBACK_SECRET_SHOP` above, or the site's `secretEnv`), the same value as in its Worker.

### 4. The guard Worker

```ts
import { createGuardWorker } from 'cf-zone-failover/guard-worker';
import { config } from './failover.config';

export default createGuardWorker(config, { label: 'Failover guard', runbook: 'https://…' });
```

A minimal `wrangler.jsonc` is in [`examples/guard.wrangler.jsonc`](examples/guard.wrangler.jsonc). The guard needs:

| Binding | What |
| --- | --- |
| `STATE` | KV namespace for its memory |
| `ALERT_EMAIL` | `send_email` binding, destinations verified in Email Routing |
| `ALERT_FROM`, `ALERT_TO` | sender on a zone with Email Routing; comma-separated recipients |
| `GUARD_MODE` | `auto` acts; anything else only decides and mails, prefixed `[observe]` |
| `CF_TOKEN_<ID>` or `CF_TOKEN` | per site: DNS Write and Zone Read on its zone; Workers Scripts Write on its account if it has Worker hosts; Pages Write if it has Pages hosts |
| `CF_TOKEN_RESERVE` or `CF_TOKEN` | SSL and Certificates Write and Zone Read on the reserve zone |

A site with `observe: true` is only watched, whatever `GUARD_MODE` says: use it for a new site's first match days.

The step-by-step setup (reserve zone, custom hostnames, validation records, tokens) is in [docs/setup.md](docs/setup.md).

## How the guard decides

Every run (a cron of `*/2 * * * *` works well), for each site:

1. Reads every ISP list once. If any is older than 30 minutes or unreadable, it decides nothing and alerts once.
2. Watches the union of the site's seed IPs, what its probe resolves to now over DoH, and what it resolved to in the last 24 h.
3. **Activates** as soon as one watched IP is blocked by any ISP, if the reserve health URL answers 200 and the reserve IPs are not blocked. If activation fails halfway it puts every name back.
4. **Goes back** after 30 minutes without a block on any ISP (blocks stop and resume within a match), or at once if the reserve is the one blocked.
5. Outside a block, **maintains the site**: puts back any public name that is not served from its zone, creates missing Worker origins, origin records and probes, retries Pages domains that lost validation, reactivates custom hostnames in `moved` (Cloudflare deletes them after 7 days otherwise), recreates missing ones, and puts the validation TXT records Cloudflare asks for in the site's zone.

One site failing does not stop the others. Every run sends at most one mail per kind of action, listing the sites; a repeated problem goes out at most once every 6 hours; three failed runs in a row too. All the timings are configurable.

## Seed IPs

Cloudflare answers a zone's A records according to where the resolver is, and ignores `edns_client_subnet`. The cron does not run in the blocked country, so it cannot see by itself which IPs that country gets. Put them in each site's `seedIps`, checked from a line in that country:

```bash
dig +short example.com A @1.1.1.1
dig +short example.com A @8.8.8.8
```

and add any new pair you see later. The guard adds what it resolves, but that is the view from wherever the cron runs.

## What it does not do

- **It notices a block only when the blocklist does.** hayahora.futbol refreshes every few minutes; add the cron interval and DNS propagation (TTL 60) on top.
- **It does not redeploy your Workers.** A deploy of a Worker whose Custom Domains moved fails while the reserve is active. Do not deploy until the guard reports the way back, and retry any deploy that failed meanwhile.
- **Pages and origin hosts lose the visitor's IP**: the backend sees the proxy's. Rate limits and logs by IP lump every visitor together during a block.
- **It does not cover IPv6-only or ISP-level DNS blocking**, only IP blocks on the sites' zones.
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
