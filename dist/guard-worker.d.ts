import { type FailoverConfig, type SiteConfig } from './config.js';
export interface GuardEnv {
    /** KV namespace for the guard's memory. */
    STATE: KVNamespace;
    /** send_email binding; the recipients must be verified in Email Routing. */
    ALERT_EMAIL: SendEmail;
    ALERT_FROM: string;
    /** Comma-separated recipients. */
    ALERT_TO: string;
    /** `auto` acts; anything else only observes. */
    GUARD_MODE?: string;
    [key: string]: unknown;
}
export interface GuardWorkerOptions<E extends GuardEnv> {
    /** Prefix of every alert subject, e.g. "Failover guard". */
    label: string;
    /**
     * Cloudflare API tokens. Default: `CF_TOKEN_RESERVE` for the reserve zone and
     * `CF_TOKEN_<SITE ID>` for each site, both falling back to `CF_TOKEN`.
     */
    tokens?: {
        reserve: (env: E) => string;
        site: (env: E, site: SiteConfig) => string;
    };
    runbook?: string;
}
/** A ready-made scheduled Worker: runs the guard, mails the alerts, and reports three failed runs in a row. */
export declare function createGuardWorker<E extends GuardEnv>(config: FailoverConfig, options: GuardWorkerOptions<E>): {
    scheduled(_controller: ScheduledController, env: E): Promise<void>;
};
