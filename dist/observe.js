/** Reads one plain-text list per ISP. A list that is old, down or unreachable makes the whole read stale. */
export async function readBlocklists(source, opts, fetcher = fetch) {
    const results = await Promise.all(source.isps.map(async (isp) => {
        const unreadable = { isp, ips: new Set(), fresh: false };
        const res = await fetcher(source.url(isp), { headers: { 'cache-control': 'no-cache' } }).catch(() => null);
        if (!res?.ok)
            return unreadable;
        const modified = Date.parse(res.headers.get('last-modified') ?? '');
        const ips = new Set((await res.text())
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean));
        return { isp, ips, fresh: Number.isFinite(modified) && opts.now - modified <= opts.maxAgeMs };
    }));
    return {
        byIsp: Object.fromEntries(results.map((r) => [r.isp, r.ips])),
        fresh: results.every((r) => r.fresh),
    };
}
/** ISPs that block any of the given IPs. */
export function blockingIsps(lists, ips) {
    return Object.keys(lists.byIsp).filter((isp) => ips.some((ip) => lists.byIsp[isp].has(ip)));
}
/** A records of a name across several DoH resolvers. Empty if none answers: the seed IPs are enough. */
export async function resolveA(name, resolvers, fetcher = fetch) {
    const answers = await Promise.allSettled(resolvers.map(async (resolver) => {
        const res = await fetcher(`${resolver}?name=${name}&type=A`, { headers: { accept: 'application/dns-json' } });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const body = (await res.json());
        return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
    }));
    return [...new Set(answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : [])))].sort();
}
/** The reserve serves the app end to end: only a 200 counts. */
export async function reserveHealthy(url, fetcher = fetch) {
    try {
        const res = await fetcher(url, { redirect: 'manual' });
        return res.status === 200;
    }
    catch {
        return false;
    }
}
