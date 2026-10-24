import { resolveConfig } from './config.js';
import { decide } from './decide.js';
import { LOCALES } from './messages.js';
import { blockingIsps, readBlocklists, reserveHealthy, resolveA } from './observe.js';
import { createReserve } from './reserve.js';
/** Short, stable key for a text (KV keys are capped at 512 bytes). */
const hash = (text) => {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
        h = (h * 33) ^ text.charCodeAt(i);
    return (h >>> 0).toString(36);
};
/** Seed IPs, those resolved now and those seen in the memory window; the memory is saved. */
async function watchedIps(state, key, seed, resolved, now, memoryMs) {
    const seen = JSON.parse((await state.get(key)) ?? '{}');
    let changed = false;
    for (const [ip, at] of Object.entries(seen)) {
        if (now - at > memoryMs) {
            delete seen[ip];
            changed = true;
        }
    }
    // Refreshing the date once an hour is enough for the memory and saves KV writes.
    for (const ip of resolved) {
        if (!(ip in seen) || now - seen[ip] > 3600_000) {
            seen[ip] = now;
            changed = true;
        }
    }
    if (changed)
        await state.put(key, JSON.stringify(seen));
    return [...new Set([...seed, ...Object.keys(seen)])].sort();
}
/** One run of the guard over every site. Meant for a cron every couple of minutes. */
export function createGuard(config, label) {
    const c = resolveConfig(config);
    const messagesOf = (site) => LOCALES[c.locale]({
        hosts: site.hosts.map((h) => h.name),
        fallbackHost: c.reserve.fallbackHost,
        healthUrl: c.reserve.healthUrl,
        blocklistName: c.blocklist.name,
        workers: [...new Set(site.hosts.flatMap((h) => (h.via === 'worker' ? [h.worker] : [])))],
    });
    /** For what does not depend on a site: subjects and the failing alert. */
    const messages = messagesOf(c.sites[0]);
    return {
        config: c,
        messages,
        /** Runs every site even if one fails, mails what happened, then throws if any failed. */
        async run(deps) {
            const { state, notify, log, now, fetcher = fetch } = deps;
            const memory = c.timing.ipMemoryMs;
            const [lists, reserveResolved, healthy] = await Promise.all([
                readBlocklists(c.blocklist, { now, maxAgeMs: c.timing.maxListAgeMs }, fetcher),
                resolveA(c.reserve.fallbackHost, c.resolvers, fetcher),
                reserveHealthy(c.reserve.healthUrl, fetcher),
            ]);
            const reserveIps = await watchedIps(state, 'reserve:seenIps', c.reserve.seedIps, reserveResolved, now, memory);
            const reserveBlockedBy = blockingIsps(lists, reserveIps);
            /** An alert that would repeat every run goes out once per cooldown. */
            const once = async (key, send) => {
                if (await state.get(`alert:${key}`))
                    return;
                await send();
                await state.put(`alert:${key}`, String(now), { expirationTtl: c.timing.alertCooldownS });
            };
            // Actions of every site in this run, one mail per kind and mode.
            const events = new Map();
            const report = (kind, mode, site, body) => {
                const key = `${kind}:${mode}`;
                const e = events.get(key) ?? { kind, mode, sites: [], bodies: [] };
                e.sites.push(site);
                e.bodies.push(body);
                events.set(key, e);
            };
            const subject = (mode, s) => `${mode === 'observe' ? messages.subject.observe : ''}${label}: ${s}`;
            async function runSite(site) {
                const st = messagesOf(site);
                const mode = site.observe ? 'observe' : deps.mode;
                const reserve = createReserve({ zone: deps.apis.site(site), reserve: deps.apis.reserve }, site, c);
                const lastKey = `${site.id}:lastBlockedAt`;
                const [zoneResolved, active, stored] = await Promise.all([
                    resolveA(site.probeHost, c.resolvers, fetcher),
                    reserve.isActive(),
                    state.get(lastKey),
                ]);
                const zoneIps = await watchedIps(state, `${site.id}:seenIps`, site.seedIps ?? [], zoneResolved, now, memory);
                const zoneBlockedBy = blockingIsps(lists, zoneIps);
                let lastBlockedAt = stored ? Number(stored) : null;
                // Reserve active with no record (activated by hand): count from now.
                if (lists.fresh && (zoneBlockedBy.length > 0 || (active && lastBlockedAt === null))) {
                    lastBlockedAt = now;
                    await state.put(lastKey, String(now));
                }
                else if (!active && lastBlockedAt !== null) {
                    // With the reserve off the date means nothing, and a later manual activation would be undone at once.
                    lastBlockedAt = null;
                    await state.delete(lastKey);
                }
                const decision = decide({ now, listsFresh: lists.fresh, zoneBlockedBy, reserveBlockedBy, reserveActive: active, reserveHealthy: healthy, lastBlockedAt }, { releaseAfterMs: c.timing.releaseAfterMs, reasons: st.reason });
                log({ site: site.id, mode, zoneResolved, reserveResolved, active, healthy, ...decision });
                const details = st.body.details({ reason: decision.reason, zoneIps, reserveIps, mode, runbook: deps.runbook });
                const withDetails = (text) => `${text}\n\n${details}`;
                // Problems are about the lists or the reserve, shared by every site: one alert, not one per site.
                if (decision.alert) {
                    const alert = decision.alert;
                    await once(alert, () => notify(subject(mode, messages.subject.problem), withDetails(st.alert[alert])));
                }
                const act = async (kind, run) => {
                    if (mode === 'auto') {
                        await run();
                        report(kind, mode, site.id, withDetails(st.body[kind]));
                    }
                    else {
                        // Observed, nothing changes and the same decision repeats every run.
                        await once(`observe:${site.id}:${kind}`, async () => report(kind, mode, site.id, withDetails(st.body[kind])));
                    }
                };
                if (decision.action === 'activate') {
                    await act('activated', () => reserve.activate());
                }
                else if (decision.action === 'deactivate') {
                    await act('deactivated', async () => {
                        await reserve.deactivate();
                        // The next activation, automatic or manual, counts from zero.
                        await state.delete(lastKey);
                    });
                }
                else if (!active && mode === 'auto') {
                    const changes = await reserve.maintain(st.change);
                    if (changes.length > 0) {
                        log({ site: site.id, maintenance: changes });
                        // Something that does not stay fixed would mail every run.
                        await once(`maintenance:${site.id}:${hash(changes.join('|'))}`, async () => report('maintenance', mode, site.id, withDetails(changes.join('\n'))));
                    }
                }
                return decision;
            }
            const outcomes = [];
            for (const site of c.sites) {
                try {
                    outcomes.push({ site: site.id, decision: await runSite(site) });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    log({ site: site.id, error: message });
                    outcomes.push({ site: site.id, error: message });
                }
            }
            for (const e of events.values()) {
                await notify(subject(e.mode, `${messages.subject[e.kind]} (${e.sites.join(', ')})`), e.bodies.join('\n\n---\n\n'));
            }
            const failed = outcomes.filter((o) => o.error);
            if (failed.length > 0)
                throw new Error(failed.map((o) => `${o.site}: ${o.error}`).join('\n'));
            return outcomes;
        },
    };
}
