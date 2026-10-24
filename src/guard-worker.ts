import { EmailMessage } from 'cloudflare:email';
import { cfApi } from './cloudflare.js';
import { envId, type FailoverConfig, type SiteConfig } from './config.js';
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
   * Cloudflare API tokens. Default: `CF_TOKEN_RESERVE` for the reserve zone and
   * `CF_TOKEN_<SITE ID>` for each site, both falling back to `CF_TOKEN`.
   */
  tokens?: { reserve: (env: E) => string; site: (env: E, site: SiteConfig) => string };
  runbook?: string;
}

function envToken(env: GuardEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value) return value;
  }
  throw new Error(`no Cloudflare token: set ${names.join(' or ')}`);
}

const DEFAULT_TOKENS = {
  reserve: (env: GuardEnv) => envToken(env, 'CF_TOKEN_RESERVE', 'CF_TOKEN'),
  site: (env: GuardEnv, site: SiteConfig) => envToken(env, `CF_TOKEN_${envId(site.id)}`, 'CF_TOKEN'),
};

/** A ready-made scheduled Worker: runs the guard, mails the alerts, and reports three failed runs in a row. */
export function createGuardWorker<E extends GuardEnv>(config: FailoverConfig, options: GuardWorkerOptions<E>) {
  const guard = createGuard(config, options.label);
  const tokens = options.tokens ?? DEFAULT_TOKENS;

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
      try {
        await guard.run({
          apis: { reserve: cfApi(tokens.reserve(env)), site: (site) => cfApi(tokens.site(env, site)) },
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
