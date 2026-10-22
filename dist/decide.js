/** Pure: what to do given what the guard sees. */
export function decide(s, opts) {
    const r = opts.reasons;
    if (!s.listsFresh)
        return { action: 'stay', reason: r.staleLists, alert: 'stale-lists' };
    const reserveBlocked = s.reserveBlockedBy.length > 0;
    if (s.zoneBlockedBy.length > 0) {
        const who = s.zoneBlockedBy.join(', ');
        if (reserveBlocked) {
            return { action: 'stay', reason: r.bothBlocked(who, s.reserveBlockedBy.join(', ')), alert: 'both-blocked' };
        }
        if (s.reserveActive)
            return { action: 'stay', reason: r.alreadyActive(who) };
        if (!s.reserveHealthy)
            return { action: 'stay', reason: r.reserveDown(who), alert: 'reserve-unhealthy' };
        return { action: 'activate', reason: r.blocked(who) };
    }
    if (!s.reserveActive)
        return { action: 'stay', reason: r.noBlock };
    if (reserveBlocked)
        return { action: 'deactivate', reason: r.reserveBlocked(s.reserveBlockedBy.join(', ')) };
    const freeFor = s.now - (s.lastBlockedAt ?? s.now);
    const minutes = Math.round(freeFor / 60_000);
    if (freeFor >= opts.releaseAfterMs)
        return { action: 'deactivate', reason: r.freeFor(minutes) };
    return { action: 'stay', reason: r.waiting(minutes, opts.releaseAfterMs / 60_000) };
}
