export type Locale = 'en' | 'es';
export type Alert = 'stale-lists' | 'both-blocked' | 'reserve-unhealthy';
/** What the messages need to know about the deployment. */
export interface MessageContext {
    publicHost: string;
    fallbackHost: string;
    healthUrl: string;
    blocklistName: string;
    worker: string;
}
export interface Messages {
    reason: {
        staleLists: string;
        bothBlocked: (zoneBy: string, reserveBy: string) => string;
        alreadyActive: (by: string) => string;
        reserveDown: (by: string) => string;
        blocked: (by: string) => string;
        noBlock: string;
        reserveBlocked: (by: string) => string;
        freeFor: (minutes: number) => string;
        waiting: (minutes: number, needed: number) => string;
    };
    alert: Record<Alert, string>;
    subject: {
        observe: string;
        problem: string;
        activated: string;
        deactivated: string;
        maintenance: string;
        failing: string;
    };
    body: {
        activated: string;
        deactivated: string;
        failing: (error: string) => string;
        details: (o: {
            reason: string;
            zoneIps: string[];
            reserveIps: string[];
            mode: string;
            runbook?: string;
        }) => string;
    };
    change: {
        recreated: (host: string) => string;
        reactivated: (host: string) => string;
        txtAdded: (name: string) => string;
        txtRemoved: (name: string) => string;
    };
}
export declare const LOCALES: Record<Locale, (c: MessageContext) => Messages>;
