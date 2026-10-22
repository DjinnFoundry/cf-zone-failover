import { EmailMessage } from 'cloudflare:email';
import { cfApi } from './cloudflare.js';
import type { GuardConfig } from './config.js';
import { buildRawEmail } from './email.js';
import { createGuard } from './guard.js';

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
  tokens?: (env: E) => { primary: string; reserve: string };
  runbook?: string;
}

/** A ready-made scheduled Worker: runs the guard, mails the alerts, and reports three failed runs in a row. */
export function createGuardWorker<E extends GuardEnv>(config: GuardConfig, options: GuardWorkerOptions<E>) {
  const guard = createGuard(config, options.label);
  const tokens =
    options.tokens ?? ((env: E) => ({ primary: String(env.CF_TOKEN_PRIMARY), reserve: String(env.CF_TOKEN_RESERVE) }));

  return {
    async scheduled(_controller: ScheduledController, env: E): Promise<void> {
      const notify = async (subject: string, body: string) => {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ error: message }));
        // One failed run is not reported: the next cron retries. Only if it repeats.
        const strikes = Number((await env.STATE.get('failures')) ?? '0') + 1;
        await env.STATE.put('failures', String(strikes), { expirationTtl: 1800 });
        if (strikes === 3) await notify(`${options.label}: ${guard.messages.subject.failing}`, guard.messages.body.failing(message));
        throw error;
      }
      if (await env.STATE.get('failures')) await env.STATE.delete('failures');
    },
  };
}
