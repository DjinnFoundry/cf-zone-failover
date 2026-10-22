import { EmailMessage } from 'cloudflare:email';
import { cfApi } from './cloudflare.js';
import { buildRawEmail } from './email.js';
import { createGuard } from './guard.js';
/** A ready-made scheduled Worker: runs the guard, mails the alerts, and reports three failed runs in a row. */
export function createGuardWorker(config, options) {
    const guard = createGuard(config, options.label);
    const tokens = options.tokens ?? ((env) => ({ primary: String(env.CF_TOKEN_PRIMARY), reserve: String(env.CF_TOKEN_RESERVE) }));
    return {
        async scheduled(_controller, env) {
            const notify = async (subject, body) => {
                for (const to of env.ALERT_TO.split(',').map((s) => s.trim()).filter(Boolean)) {
                    const raw = buildRawEmail({
                        from: env.ALERT_FROM,
                        fromName: guard.config.senderName,
                        to,
                        subject,
                        body,
                        date: new Date(),
                        id: crypto.randomUUID(),
                    });
                    await env.ALERT_EMAIL.send(new EmailMessage(env.ALERT_FROM, to, raw));
                }
            };
            const { primary, reserve } = tokens(env);
            try {
                await guard.run({
                    apis: { primary: cfApi(primary), reserve: cfApi(reserve) },
                    state: env.STATE,
                    notify,
                    log: (entry) => console.log(JSON.stringify(entry)),
                    mode: env.GUARD_MODE === 'auto' ? 'auto' : 'observe',
                    now: Date.now(),
                    runbook: options.runbook,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(JSON.stringify({ error: message }));
                // One failed run is not reported: the next cron retries. Only if it repeats.
                const strikes = Number((await env.STATE.get('failures')) ?? '0') + 1;
                await env.STATE.put('failures', String(strikes), { expirationTtl: 1800 });
                if (strikes === 3)
                    await notify(`${options.label}: ${guard.messages.subject.failing}`, guard.messages.body.failing(message));
                throw error;
            }
            if (await env.STATE.get('failures'))
                await env.STATE.delete('failures');
        },
    };
}
