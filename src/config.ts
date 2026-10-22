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

export interface GuardConfig {
  primary: {
    /** Account that owns the main Worker and its Custom Domains. */
    accountId: string;
    /** Zone of the public hostnames. */
    zoneId: string;
    /** Name of the main Worker (the service of the Custom Domains). */
    worker: string;
    /** Hostnames that move to the reserve during a block. */
    publicHosts: readonly string[];
    /**
     * Custom Domain of the main Worker in the same zone (the proxy's
     * `originHost`): it keeps resolving to the zone's IPs while the reserve is
     * active, so the guard can tell when the block ends.
     */
    probeHost: string;
  };
  reserve: {
    /** Reserve zone that holds the Cloudflare for SaaS custom hostnames. */
    zoneId: string;
    /** Fallback origin of the reserve zone: the CNAME target during a block. */
    fallbackHost: string;
    /** A URL that crosses the whole reserve chain; only a 200 counts as healthy. */
    healthUrl: string;
  };
  /**
   * IPs to watch on top of what the guard resolves. Cloudflare answers by
   * resolver location and ignores edns_client_subnet, and the cron does not run
   * in the blocked country: list here what that country sees.
   */
  seedIps?: { zone?: readonly string[]; reserve?: readonly string[] };
  blocklist?: BlocklistSource;
  resolvers?: readonly string[];
  timing?: Partial<Timing>;
  /**
   * Comments on the DNS records the reserve creates. Stale validation TXT
   * records are only deleted if their comment contains `marker`.
   */
  dns?: { cnameComment?: string; txtComment?: string; marker?: string };
  /** Language of the alerts and decision reasons. Default `en`. */
  locale?: Locale;
  /** Display name of the alert sender. */
  senderName?: string;
}

export interface ResolvedConfig {
  primary: GuardConfig['primary'];
  reserve: GuardConfig['reserve'];
  seedIps: { zone: readonly string[]; reserve: readonly string[] };
  blocklist: BlocklistSource;
  resolvers: readonly string[];
  timing: Timing;
  dns: { cnameComment: string; txtComment: string; marker: string };
  locale: Locale;
  senderName: string;
}

export const DEFAULT_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

export function resolveConfig(config: GuardConfig): ResolvedConfig {
  if (config.primary.publicHosts.length === 0) throw new Error('cf-zone-failover: primary.publicHosts is empty');
  const marker = config.dns?.marker ?? 'zone-failover';
  return {
    primary: config.primary,
    reserve: config.reserve,
    seedIps: { zone: config.seedIps?.zone ?? [], reserve: config.seedIps?.reserve ?? [] },
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
