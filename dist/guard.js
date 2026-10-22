import { resolveConfig } from './config.js';
import { decide } from './decide.js';
import { LOCALES } from './messages.js';
import { blockingIsps, readBlocklists, reserveHealthy, resolveA } from './observe.js';
import { createReserve } from './reserve.js';
const LAST_BLOCKED = 'lastBlockedAt';
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
/** One run of the guard. Meant for a cron every couple of minutes. */
export function createGuard(config, label) {
    const c = resolveConfig(config);
    const t = LOCALES[c.locale]({
        publicHost: c.primary.publicHosts[0],
        fallbackHost: c.reserve.fallbackHost,
        healthUrl: c.reserve.healthUrl,
        blocklistName: c.blocklist.name,
        worker: c.primary.worker,
    });
    return {
        config: c,
        messages: t,
        async run(deps) {
            const { apis, state, notify, log, mode, now, fetcher = fetch } = deps;
            const reserve = createReserve(apis, c);
            const [lists, zoneResolved, reserveResolved, active, healthy, storedLastBlocked] = await Promise.all([
                readBlocklists(c.blocklist, { now, maxAgeMs: c.timing.maxListAgeMs }, fetcher),
                resolveA(c.primary.probeHost, c.resolvers, fetcher),
                resolveA(c.reserve.fallbackHost, c.resolvers, fetcher),
                reserve.isActive(),
                reserveHealthy(c.reserve.healthUrl, fetcher),
                state.get(LAST_BLOCKED),
            ]);
            const memory = c.timing.ipMemoryMs;
            const zoneIps = await watchedIps(state, 'seenIps:zone', c.seedIps.zone, zoneResolved, now, memory);
            const reserveIps = await watchedIps(state, 'seenIps:reserve', c.seedIps.reserve, reserveResolved, now, memory);
            const zoneBlockedBy = blockingIsps(lists, zoneIps);
            let lastBlockedAt = storedLastBlocked ? Number(storedLastBlocked) : null;
            // Reserve active with no record (activated by hand): count from now.
            if (lists.fresh && (zoneBlockedBy.length > 0 || (active && lastBlockedAt === null))) {
                lastBlockedAt = now;
                await state.put(LAST_BLOCKED, String(now));
            }
            else if (!active && lastBlockedAt !== null) {
                // With the reserve off the date means nothing, and a later manual activation would be undone at once.
                lastBlockedAt = null;
                await state.delete(LAST_BLOCKED);
            }
            const decision = decide({
                now,
                listsFresh: lists.fresh,
                zoneBlockedBy,
                reserveBlockedBy: blockingIsps(lists, reserveIps),
                reserveActive: active,
                reserveHealthy: healthy,
                lastBlockedAt,
            }, { releaseAfterMs: c.timing.releaseAfterMs, reasons: t.reason });
            log({ mode, zoneResolved, reserveResolved, active, healthy, ...decision });
            const details = t.body.details({ reason: decision.reason, zoneIps, reserveIps, mode, runbook: deps.runbook });
            const subject = (s) => `${mode === 'observe' ? t.subject.observe : ''}${label}: ${s}`;
            /** An alert that would repeat every run goes out once per cooldown. */
            const notifyOnce = async (key, subj, body) => {
                if (await state.get(`alert:${key}`))
                    return;
                await notify(subj, body);
                await state.put(`alert:${key}`, String(now), { expirationTtl: c.timing.alertCooldownS });
            };
            // In observe mode nothing changes, so the same decision repeats every run.
            const notifyAction = mode === 'auto' ? notify : (subj, body) => notifyOnce(`observe:${decision.action}`, subj, body);
            if (decision.alert) {
                await notifyOnce(decision.alert, subject(t.subject.problem), `${t.alert[decision.alert]}\n\n${details}`);
            }
            if (decision.action === 'activate') {
                if (mode === 'auto')
                    await reserve.activate();
                await notifyAction(subject(t.subject.activated), `${t.body.activated}\n\n${details}`);
            }
            else if (decision.action === 'deactivate') {
                if (mode === 'auto') {
                    await reserve.deactivate();
                    // The next activation, automatic or manual, counts from zero.
                    await state.delete(LAST_BLOCKED);
                }
                await notifyAction(subject(t.subject.deactivated), `${t.body.deactivated}\n\n${details}`);
            }
            else if (!active && mode === 'auto') {
                const changes = await reserve.maintain(t.change);
                if (changes.length > 0) {
                    log({ maintenance: changes });
                    await notify(subject(t.subject.maintenance), `${changes.join('\n')}\n\n${details}`);
                }
            }
            return decision;
        },
    };
}
