import type { CfApi } from './cloudflare.js';
import { type ResolvedConfig, type SiteConfig } from './config.js';
import type { Messages } from './messages.js';
/**
 * `zone` signs in the site's account and zone; `reserve` in the reserve zone.
 * They can be the same token.
 */
export interface SiteApis {
    zone: CfApi;
    reserve: CfApi;
}
export interface Reserve {
    /** The reserve is active if a public hostname has a CNAME to the fallback host. */
    isActive(): Promise<boolean>;
    /**
     * Takes each public hostname off its zone (Worker Custom Domain or DNS
     * records) and points it at the reserve. If it fails halfway it puts every
     * name back: a name with nothing is down for everyone.
     */
    activate(): Promise<void>;
    /** Removes the reserve CNAMEs and puts each public hostname back where it was served. */
    deactivate(): Promise<void>;
    /**
     * Outside a block, keeps the site ready for the next one and returns what
     * changed:
     * - each public hostname is served from its zone (repairs a half-done return);
     * - the Worker origins, origin records and probe exist;
     * - Pages custom domains that lost validation retry it;
     * - each public hostname is a custom hostname of the reserve, reactivated
     *   from `moved` (Cloudflare deletes it after 7 days otherwise);
     * - the validation TXT records Cloudflare asks for are in the zone, and old
     *   ones with the marker are gone.
     */
    maintain(changes: Messages['change']): Promise<string[]>;
    /**
     * With the reserve active, brings in the public hostnames still served
     * from the zone (added to the config during a block) and returns what
     * changed: each gets its custom hostname on the reserve and the validation
     * TXT records, and moves to the reserve once both the hostname and its
     * certificate are active. Hosts already moved are never touched. Reuses the
     * records `isActive` read on this instance, so with nothing left out it
     * makes no call. If a move fails, that host goes back to its zone.
     */
    catchUp(changes: Messages['change']): Promise<string[]>;
}
export declare function createReserve(apis: SiteApis, site: SiteConfig, config: Pick<ResolvedConfig, 'reserve' | 'dns'>): Reserve;
