/**
 * hayahora.futbol publishes, for each Spanish ISP, the Cloudflare IPs blocked
 * under the LaLiga court order, refreshed every few minutes. Freshness comes
 * from each list's Last-Modified header.
 */
export const HAYAHORA = {
    name: 'hayahora.futbol',
    isps: ['movistar', 'orange', 'vodafone', 'digi', 'masmovil'],
    url: (isp) => `https://hayahora.futbol/estado/blocked-${isp}.txt`,
};
export const DEFAULT_TIMING = {
    maxListAgeMs: 30 * 60_000,
    releaseAfterMs: 30 * 60_000,
    alertCooldownS: 6 * 3600,
    ipMemoryMs: 24 * 3600_000,
};
export const DEFAULT_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
export function resolveConfig(config) {
    if (config.primary.publicHosts.length === 0)
        throw new Error('cf-zone-failover: primary.publicHosts is empty');
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
