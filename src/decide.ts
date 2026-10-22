import type { Alert, Messages } from './messages.js';

export interface Situation {
  now: number;
  listsFresh: boolean;
  /** ISPs blocking the primary zone's IPs right now. */
  zoneBlockedBy: string[];
  /** ISPs blocking the reserve zone's IPs right now. */
  reserveBlockedBy: string[];
  reserveActive: boolean;
  reserveHealthy: boolean;
  /** Last time the zone was seen blocked (or the reserve seen active without that record). */
  lastBlockedAt: number | null;
}

export interface Decision {
  action: 'activate' | 'deactivate' | 'stay';
  reason: string;
  alert?: Alert;
}

/** Pure: what to do given what the guard sees. */
export function decide(s: Situation, opts: { releaseAfterMs: number; reasons: Messages['reason'] }): Decision {
  const r = opts.reasons;
  if (!s.listsFresh) return { action: 'stay', reason: r.staleLists, alert: 'stale-lists' };

  const reserveBlocked = s.reserveBlockedBy.length > 0;
  const reserveBy = s.reserveBlockedBy.join(', ');

  if (s.zoneBlockedBy.length > 0) {
    const who = s.zoneBlockedBy.join(', ');
    if (reserveBlocked) {
      return { action: 'stay', reason: r.bothBlocked(who, reserveBy), alert: 'both-blocked' };
    }
    if (s.reserveActive) return { action: 'stay', reason: r.alreadyActive(who) };
    if (!s.reserveHealthy) return { action: 'stay', reason: r.reserveDown(who), alert: 'reserve-unhealthy' };
    return { action: 'activate', reason: r.blocked(who) };
  }

  if (!s.reserveActive) return { action: 'stay', reason: r.noBlock };
  if (reserveBlocked) return { action: 'deactivate', reason: r.reserveBlocked(reserveBy) };

  const freeFor = s.now - (s.lastBlockedAt ?? s.now);
  const minutes = Math.round(freeFor / 60_000);
  if (freeFor >= opts.releaseAfterMs) return { action: 'deactivate', reason: r.freeFor(minutes) };
  return { action: 'stay', reason: r.waiting(minutes, opts.releaseAfterMs / 60_000) };
}
