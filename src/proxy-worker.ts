import { resolveConfig, secretEnvOf, targetOf, type FailoverConfig, type HostConfig, type SiteConfig } from './config.js';
import { createSigning, type Signing, type StreamingRequestInit } from './signing.js';

/** The proxy reads each site's secret by name: `FALLBACK_SECRET_<ID>` or the site's `secretEnv`. */
export type ProxyEnv = Record<string, unknown>;

interface Route {
  site: SiteConfig;
  host: HostConfig;
  /** Only `worker` hosts: the signed hand-off to their origin. */
  signing?: Signing;
}

const notFound = () => new Response('Not Found', { status: 404 });

/** Public hostname → how to reach it. A site's test hostnames route as its first host. */
export function proxyRoutes(sites: readonly SiteConfig[]): (hostname: string) => Route | null {
  const routes = new Map<string, Route>();
  for (const site of sites) {
    // One signing per origin: it only accepts the public names that share it.
    const byOrigin = new Map<string, string[]>();
    for (const h of site.hosts) {
      if (h.via !== 'worker') continue;
      const group = byOrigin.get(h.origin) ?? [];
      group.push(h.name);
      byOrigin.set(h.origin, group);
    }
    const first = site.hosts[0]!.name;
    const signings = new Map(
      [...byOrigin].map(([originHost, publicHosts]) => [
        originHost,
        createSigning({
          originHost,
          publicHosts,
          headerPrefix: site.headerPrefix,
          // Test hostnames route as the first host, so only its signing accepts them.
          testHostPattern: publicHosts[0] === first ? site.testHostPattern : undefined,
        }),
      ]),
    );
    for (const host of site.hosts) {
      routes.set(host.name, { site, host, signing: host.via === 'worker' ? signings.get(host.origin) : undefined });
    }
  }
  return (hostname) => {
    const exact = routes.get(hostname);
    if (exact) return exact;
    const site = sites.find((s) => s.testHostPattern?.test(hostname));
    return site ? routes.get(site.hosts[0]!.name)! : null;
  };
}

/**
 * Plain hand-off to a target that serves the public name's content under its
 * own name (`pages.dev`, an origin record). Absolute redirects to the target
 * go back to the public name; every other header passes as is, so a site's
 * own `x-robots-tag` survives. Production `pages.dev` names add none (only
 * preview deployments do).
 */
async function forward(request: Request, host: Exclude<HostConfig, { via: 'worker' }>): Promise<Response> {
  const publicHost = host.name;
  const target = targetOf(host);
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', publicHost);
  headers.set('x-forwarded-proto', 'https');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: StreamingRequestInit = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    duplex: hasBody ? 'half' : undefined,
  };
  const res = await fetch(`https://${target}${url.pathname}${url.search}`, init);

  const out = new Response(res.body, res);
  const location = out.headers.get('location');
  if (location && /^https?:\/\//i.test(location)) {
    const moved = new URL(location);
    if (moved.hostname === target) {
      moved.hostname = publicHost;
      out.headers.set('location', moved.toString());
    }
  }
  return out;
}

/**
 * The reserve Worker: routed on the reserve zone, it serves every configured
 * public hostname from its target and returns the response as is.
 */
export function createFailoverProxy(config: FailoverConfig) {
  const route = proxyRoutes(resolveConfig(config).sites);
  return {
    async fetch(request: Request, env: ProxyEnv): Promise<Response> {
      const found = route(new URL(request.url).hostname);
      if (!found) return notFound();
      const { site, host, signing } = found;
      if (host.via !== 'worker') return forward(request, host);

      const secretEnv = secretEnvOf(site);
      const secret = env[secretEnv];
      if (typeof secret !== 'string' || !secret) {
        console.error(`[cf-zone-failover] ${secretEnv} is not set`);
        return new Response('Server misconfigured', { status: 500 });
      }
      return fetch(signing!.toFallbackOrigin(request, secret)!);
    },
  };
}
