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
/** `my-site` → `MY_SITE`, for variable names. */
export const envId = (id) => id.toUpperCase().replace(/-/g, '_');
/** Name of the proxy variable with a site's shared secret. */
export const secretEnvOf = (site) => site.secretEnv ?? `FALLBACK_SECRET_${envId(site.id)}`;
/** The hostname the reserve proxy fetches for a public hostname. */
export const targetOf = (host) => host.via === 'pages' ? (host.subdomain ?? `${host.project}.pages.dev`) : host.origin;
/** Hostnames the reserve proxy fetches for a site: they must never move. */
export const targetsOf = (site) => site.hosts.map(targetOf);
function validate(sites) {
    const fail = (message) => {
        throw new Error(`cf-zone-failover: ${message}`);
    };
    if (sites.length === 0)
        fail('no sites');
    const ids = new Set();
    const hosts = new Set();
    for (const site of sites) {
        if (!/^[a-z0-9-]+$/.test(site.id))
            fail(`site id "${site.id}" must be a-z, 0-9 and -`);
        if (ids.has(site.id))
            fail(`site id "${site.id}" repeated`);
        ids.add(site.id);
        if (site.hosts.length === 0)
            fail(`site ${site.id} has no hosts`);
        const own = new Set(site.hosts.map((h) => h.name));
        for (const name of own) {
            if (hosts.has(name))
                fail(`${name} is in more than one site`);
            hosts.add(name);
        }
        for (const name of [site.probeHost, ...targetsOf(site)]) {
            if (own.has(name))
                fail(`${name} in site ${site.id} moves to the reserve, so it cannot be a probe or a target`);
        }
    }
}
export function resolveConfig(config) {
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
