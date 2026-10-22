import type { GuardConfig } from './config.js';
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
     * The two Cloudflare API tokens. Default: env.CF_TOKEN_PRIMARY (DNS and
     * Workers routes of the primary zone, Workers Scripts of its account) and
     * env.CF_TOKEN_RESERVE (SSL and Certificates of the reserve zone).
     */
    tokens?: (env: E) => {
        primary: string;
        reserve: string;
    };
    runbook?: string;
}
/** A ready-made scheduled Worker: runs the guard, mails the alerts, and reports three failed runs in a row. */
export declare function createGuardWorker<E extends GuardEnv>(config: GuardConfig, options: GuardWorkerOptions<E>): {
    scheduled(_controller: ScheduledController, env: E): Promise<void>;
};
