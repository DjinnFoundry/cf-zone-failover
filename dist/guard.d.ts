import type { CfApi } from './cloudflare.js';
import { type FailoverConfig, type SiteConfig } from './config.js';
import { type Decision } from './decide.js';
import { type Messages } from './messages.js';
export type GuardState = Pick<KVNamespace, 'get' | 'put' | 'delete'>;
export interface GuardDeps {
    apis: {
        /** Signs in the reserve zone. */
        reserve: CfApi;
        /** Signs in a site's account and zone. */
        site: (site: SiteConfig) => CfApi;
    };
    state: GuardState;
    notify: (subject: string, body: string) => Promise<void>;
    log: (entry: Record<string, unknown>) => void;
    /** `observe` decides and alerts but touches nothing. A site with `observe: true` is always observed. */
    mode: 'auto' | 'observe';
    now: number;
    fetcher?: typeof fetch;
    /** Linked from every alert. */
    runbook?: string;
}
export interface SiteOutcome {
    site: string;
    decision?: Decision;
    error?: string;
}
/** One run of the guard over every site. Meant for a cron every couple of minutes. */
export declare function createGuard(config: FailoverConfig, label: string): {
    config: import("./config.js").ResolvedConfig;
    messages: Messages;
    /** Runs every site even if one fails, mails what happened, then throws if any failed. */
    run(deps: GuardDeps): Promise<SiteOutcome[]>;
};
