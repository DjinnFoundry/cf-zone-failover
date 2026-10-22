import type { CfApi } from './cloudflare.js';
import type { ResolvedConfig } from './config.js';
import type { Messages } from './messages.js';
/**
 * `primary` signs in the account and zone of the main Worker; `reserve` in the
 * reserve zone. They can be the same token if one account owns both.
 */
export interface ReserveApis {
    primary: CfApi;
    reserve: CfApi;
}
export interface Reserve {
    /** The reserve is active if a public hostname has a CNAME to the fallback host. */
    isActive(): Promise<boolean>;
    /**
     * Detaches the production Custom Domains and points the public hostnames at
     * the reserve. If it fails halfway, it reattaches the Custom Domains: a name
     * with neither Custom Domain nor CNAME is down for everyone.
     */
    activate(): Promise<void>;
    /** Removes the reserve CNAMEs and reattaches the Custom Domains to the main Worker. */
    deactivate(): Promise<void>;
    /**
     * Keeps the reserve ready for the next block and returns what changed:
     * - a custom hostname in `moved` (the public name stopped pointing at the
     *   reserve) is reactivated; otherwise Cloudflare deletes it after 7 days;
     * - a missing one is recreated;
     * - the validation TXT records Cloudflare asks for (issuance or renewal) are
     *   put in the primary zone, and the old ones with the marker are removed.
     */
    maintain(changes: Messages['change']): Promise<string[]>;
}
export declare function createReserve(apis: ReserveApis, config: ResolvedConfig): Reserve;
