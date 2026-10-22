const SSL_TXT = { ssl: { method: 'txt', type: 'dv' } };
export function createReserve(apis, config) {
    const { primary, reserve, dns } = config;
    const isPublic = (name) => primary.publicHosts.includes(name);
    const zoneRecords = `/zones/${primary.zoneId}/dns_records`;
    const workerDomains = `/accounts/${primary.accountId}/workers/domains`;
    const customHostnames = `/zones/${reserve.zoneId}/custom_hostnames`;
    async function reserveCnames() {
        const records = await apis.primary('GET', `${zoneRecords}?type=CNAME&per_page=100`);
        return records.filter((r) => isPublic(r.name) && r.content === reserve.fallbackHost);
    }
    async function attachCustomDomains() {
        for (const hostname of primary.publicHosts) {
            await apis.primary('PUT', workerDomains, {
                hostname,
                service: primary.worker,
                zone_id: primary.zoneId,
                environment: 'production',
            });
        }
    }
    /** Removes the reserve CNAMEs and reattaches the Custom Domains. */
    async function restorePrimary() {
        for (const r of await reserveCnames())
            await apis.primary('DELETE', `${zoneRecords}/${r.id}`);
        await attachCustomDomains();
    }
    return {
        async isActive() {
            return (await reserveCnames()).length > 0;
        },
        async activate() {
            const domains = await apis.primary('GET', workerDomains);
            try {
                for (const d of domains.filter((d) => isPublic(d.hostname))) {
                    await apis.primary('DELETE', `${workerDomains}/${d.id}`);
                }
                for (const name of primary.publicHosts) {
                    await apis.primary('POST', zoneRecords, {
                        type: 'CNAME',
                        name,
                        content: reserve.fallbackHost,
                        proxied: false,
                        ttl: 60,
                        comment: dns.cnameComment,
                    });
                }
            }
            catch (error) {
                await restorePrimary();
                throw error;
            }
        },
        deactivate: restorePrimary,
        async maintain(say) {
            const changes = [];
            const all = await apis.reserve('GET', `${customHostnames}?per_page=50`);
            const hostnames = [];
            for (const hostname of primary.publicHosts) {
                let h = all.find((x) => x.hostname === hostname);
                if (!h) {
                    h = await apis.reserve('POST', customHostnames, { hostname, ...SSL_TXT });
                    changes.push(say.recreated(hostname));
                }
                else if (h.status === 'moved') {
                    h = await apis.reserve('PATCH', `${customHostnames}/${h.id}`, SSL_TXT);
                    changes.push(say.reactivated(hostname));
                }
                hostnames.push(h);
            }
            const wanted = new Map();
            const want = (name, value) => {
                if (!name || !value)
                    return;
                if (!wanted.has(name))
                    wanted.set(name, new Set());
                wanted.get(name).add(value);
            };
            for (const h of hostnames) {
                for (const v of h.ssl?.validation_records ?? [])
                    want(v.txt_name, v.txt_value);
                if (h.ownership_verification?.type === 'txt')
                    want(h.ownership_verification.name, h.ownership_verification.value);
            }
            if (wanted.size === 0)
                return changes;
            const txt = await apis.primary('GET', `${zoneRecords}?type=TXT&per_page=100`);
            const unquote = (s) => s.replace(/^"|"$/g, '');
            for (const [name, values] of wanted) {
                const existing = txt.filter((r) => r.name === name);
                for (const value of values) {
                    if (existing.some((r) => unquote(r.content) === value))
                        continue;
                    await apis.primary('POST', zoneRecords, { type: 'TXT', name, content: `"${value}"`, ttl: 300, comment: dns.txtComment });
                    changes.push(say.txtAdded(name));
                }
                // Only the reserve's own records: the zone uses other, hidden TXT records for its own certificate.
                for (const r of existing) {
                    if (r.comment?.includes(dns.marker) && !values.has(unquote(r.content))) {
                        await apis.primary('DELETE', `${zoneRecords}/${r.id}`);
                        changes.push(say.txtRemoved(name));
                    }
                }
            }
            return changes;
        },
    };
}
