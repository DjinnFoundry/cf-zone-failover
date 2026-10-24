import type { Locale } from './messages.js';

/** Where to read which IPs each ISP is blocking right now. */
export interface BlocklistSource {
  /** Shown in alerts. */
  name: string;
  isps: readonly string[];
  /** A plain-text list for one ISP: one IP per line, empty when nothing is blocked. */
  url: (isp: string) => string;
}

/**
 * hayahora.futbol publishes, for each Spanish ISP, the Cloudflare IPs blocked
 * under the LaLiga court order, refreshed every few minutes. Freshness comes
 * from each list's Last-Modified header.
 */
export const HAYAHORA: BlocklistSource = {
  name: 'hayahora.futbol',
  isps: ['movistar', 'orange', 'vodafone', 'digi', 'masmovil'],
  url: (isp) => `https://hayahora.futbol/estado/blocked-${isp}.txt`,
};

export interface Timing {
  /** Lists older than this are not trusted to decide anything. */
  maxListAgeMs: number;
  /** Time without a block before going back: blocks stop and resume within a match. */
  releaseAfterMs: number;
  /** The same problem alert is not repeated before this. */
  alertCooldownS: number;
  /** How long an IP seen in DNS stays watched after it stops resolving. */
  ipMemoryMs: number;
}

export const DEFAULT_TIMING: Timing = {
  maxListAgeMs: 30 * 60_000,
  releaseAfterMs: 30 * 60_000,
  alertCooldownS: 6 * 3600,
  ipMemoryMs: 24 * 3600_000,
};

/**
 * How a public hostname is served on its zone, and how the reserve proxy
 * reaches it during a block. The reserve cannot fetch the public name itself:
 * during a block it resolves to the reserve and the request would loop.
 *
 * - `worker`: a Custom Domain of a Worker. The proxy forwards, signed, to
 *   `origin`, another Custom Domain of the same Worker in the same zone, and
 *   the Worker undoes the hand-off with `createSigning().fromFallbackProxy`.
 * - `pages`: a Pages custom domain (a proxied CNAME to the project's
 *   `pages.dev` name). The proxy fetches that name: `<project>.pages.dev`, or
 *   `subdomain` when Pages added a suffix because the name was taken
 *   (`example-docs-a1b.pages.dev`).
 * - `origin`: any other proxied record, such as a tunnel or a server. The
 *   proxy fetches `origin`, a proxied record of the zone with the same target
 *   that never moves. The backend must answer to that name too (for a tunnel,
 *   an ingress rule with `httpHostHeader` set to the public name).
 */
export type HostConfig =
  | { name: string; via: 'worker'; worker: string; origin: string }
  | { name: string; via: 'pages'; project: string; subdomain?: string }
  | { name: string; via: 'origin'; origin: string };

/** One zone and the hostnames of it that move to the reserve together. */
export interface SiteConfig {
  /**
   * Short id (`a-z`, `0-9`, `-`) for alerts and state, and for the default
   * names of its secret (`FALLBACK_SECRET_<ID>`) and token (`CF_TOKEN_<ID>`).
   */
  id: string;
  accountId: string;
  zoneId: string;
  hosts: readonly HostConfig[];
  /**
   * A proxied name in the zone that never moves, so the guard still learns
   * the zone's IPs while the reserve is active: a `worker` or `origin` target
   * of this site, or any other name. If it has no record, the guard creates
   * one (AAAA `100::`, proxied).
   */
  probeHost: string;
  /**
   * What the blocked country sees for this zone. Cloudflare answers by
   * resolver location and ignores edns_client_subnet, and the cron does not
   * run in that country.
   */
  seedIps?: readonly string[];
  /** Prefix of the signed hand-off headers of `worker` hosts. Default `x-zone-failover`. */
  headerPrefix?: string;
  /** Proxy variable with this site's shared secret. Default `FALLBACK_SECRET_<ID>`. */
  secretEnv?: string;
  /** Extra hostnames on the reserve served as `hosts[0]`, such as a permanent health check. */
  testHostPattern?: RegExp;
  /** Decide and alert, but never touch this site: for its first match days. */
  observe?: boolean;
}

export interface FailoverConfig {
  reserve: {
    /** Reserve zone that holds the Cloudflare for SaaS custom hostnames. */
    zoneId: string;
    /** Fallback origin of the reserve zone: the CNAME target during a block. */
    fallbackHost: string;
    /** A URL that crosses the whole reserve chain; only a 200 counts as healthy. */
    healthUrl: string;
    /** What the blocked country sees for the reserve zone. */
    seedIps?: readonly string[];
  };
  sites: readonly SiteConfig[];
  blocklist?: BlocklistSource;
  resolvers?: readonly string[];
  timing?: Partial<Timing>;
  /**
   * Comments on the DNS records the guard creates. Stale validation TXT
   * records are only deleted if their comment contains `marker`.
   */
  dns?: { cnameComment?: string; txtComment?: string; marker?: string };
  /** Language of the alerts and decision reasons. Default `en`. */
  locale?: Locale;
  /** Display name of the alert sender. */
  senderName?: string;
}

export interface ResolvedConfig {
  reserve: FailoverConfig['reserve'] & { seedIps: readonly string[] };
  sites: readonly SiteConfig[];
  blocklist: BlocklistSource;
  resolvers: readonly string[];
  timing: Timing;
  dns: { cnameComment: string; txtComment: string; marker: string };
  locale: Locale;
  senderName: string;
}

export const DEFAULT_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

/** `my-site` → `MY_SITE`, for variable names. */
export const envId = (id: string) => id.toUpperCase().replace(/-/g, '_');

/** Name of the proxy variable with a site's shared secret. */
export const secretEnvOf = (site: SiteConfig) => site.secretEnv ?? `FALLBACK_SECRET_${envId(site.id)}`;

/** The hostname the reserve proxy fetches for a public hostname. */
export const targetOf = (host: HostConfig) =>
  host.via === 'pages' ? (host.subdomain ?? `${host.project}.pages.dev`) : host.origin;

/** Hostnames the reserve proxy fetches for a site: they must never move. */
export const targetsOf = (site: SiteConfig) => site.hosts.map(targetOf);

function validate(sites: readonly SiteConfig[]): void {
  const fail = (message: string) => {
    throw new Error(`cf-zone-failover: ${message}`);
  };
  if (sites.length === 0) fail('no sites');
  const ids = new Set<string>();
  const hosts = new Set<string>();
  for (const site of sites) {
    if (!/^[a-z0-9-]+$/.test(site.id)) fail(`site id "${site.id}" must be a-z, 0-9 and -`);
    if (ids.has(site.id)) fail(`site id "${site.id}" repeated`);
    ids.add(site.id);
    if (site.hosts.length === 0) fail(`site ${site.id} has no hosts`);
    const own = new Set(site.hosts.map((h) => h.name));
    for (const name of own) {
      if (hosts.has(name)) fail(`${name} is in more than one site`);
      hosts.add(name);
    }
    for (const name of [site.probeHost, ...targetsOf(site)]) {
      if (own.has(name)) fail(`${name} in site ${site.id} moves to the reserve, so it cannot be a probe or a target`);
    }
  }
}

export function resolveConfig(config: FailoverConfig): ResolvedConfig {
  validate(config.sites);
  const marker = config.dns?.marker ?? 'zone-failover';
  return {
    reserve: { ...config.reserve, seedIps: config.reserve.seedIps ?? [] },
    sites: config.sites,
    blocklist: config.blocklist ?? HAYAHORA,
    resolvers: config.resolvers ?? DEFAULT_RESOLVERS,
    timing: { ...DEFAULT_TIMING, ...config.timing },
    dns: {
      marker,
      cnameComment: config.dns?.cnameComment ?? `${marker}: reserve ACTIVE, removed when the block ends`,
      txtComment: config.dns?.txtComment ?? `${marker}: custom hostname validation on the reserve zone`,
    },
    locale: config.locale ?? 'en',
    senderName: config.senderName ?? 'Zone failover guard',
  };
}
