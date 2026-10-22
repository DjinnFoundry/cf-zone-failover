import { type GuardConfig } from './config.js';
import { type Decision } from './decide.js';
import { type ReserveApis } from './reserve.js';
export type GuardState = Pick<KVNamespace, 'get' | 'put' | 'delete'>;
export interface GuardDeps {
    apis: ReserveApis;
    state: GuardState;
    notify: (subject: string, body: string) => Promise<void>;
    log: (entry: Record<string, unknown>) => void;
    /** `observe` decides and alerts but touches nothing. */
    mode: 'auto' | 'observe';
    now: number;
    fetcher?: typeof fetch;
    /** Linked from every alert. */
    runbook?: string;
}
/** One run of the guard. Meant for a cron every couple of minutes. */
export declare function createGuard(config: GuardConfig, label: string): {
    config: import("./config.js").ResolvedConfig;
    messages: import("./messages.js").Messages;
    run(deps: GuardDeps): Promise<Decision>;
};
