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
export declare function decide(s: Situation, opts: {
    releaseAfterMs: number;
    reasons: Messages['reason'];
}): Decision;
