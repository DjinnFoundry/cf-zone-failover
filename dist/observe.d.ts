import type { BlocklistSource } from './config.js';
export interface Blocklists {
    /** IPs blocked right now, per ISP. */
    byIsp: Record<string, Set<string>>;
    /** Every list is recent and could be read. */
    fresh: boolean;
}
/** Reads one plain-text list per ISP. A list that is old, down or unreachable makes the whole read stale. */
export declare function readBlocklists(source: BlocklistSource, opts: {
    now: number;
    maxAgeMs: number;
}, fetcher?: typeof fetch): Promise<Blocklists>;
/** ISPs that block any of the given IPs. */
export declare function blockingIsps(lists: Blocklists, ips: readonly string[]): string[];
/** A records of a name across several DoH resolvers. Empty if none answers: the seed IPs are enough. */
export declare function resolveA(name: string, resolvers: readonly string[], fetcher?: typeof fetch): Promise<string[]>;
/** The reserve serves the app end to end: only a 200 counts. */
export declare function reserveHealthy(url: string, fetcher?: typeof fetch): Promise<boolean>;
