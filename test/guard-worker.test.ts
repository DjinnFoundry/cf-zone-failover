import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardWorker, type GuardEnv } from '../src/guard-worker.js';
import { CONFIG, NOW, ZONE_IPS } from './fixtures.js';

function kv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  } as unknown as KVNamespace & { data: Map<string, string> };
}

/** Everything the guard fetches: lists, DoH, health check and the Cloudflare API. */
function stubInternet(opts: { apiFails?: boolean; blocked?: string[] } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('hayahora')) {
        const body = url.includes('movistar') ? (opts.blocked ?? []).join('\n') : '';
        return new Response(body, { headers: { 'last-modified': new Date(Date.now() - 60_000).toUTCString() } });
      }
      if (url.startsWith('https://api.cloudflare.com/')) {
        if (opts.apiFails) return Response.json({ success: false, errors: [{ message: 'boom' }] }, { status: 500 });
        return Response.json({ success: true, result: [] });
      }
      if (url.includes('dns')) return Response.json({ Answer: [] });
      if (url === CONFIG.reserve.healthUrl) return new Response('ok');
      throw new Error(`not simulated: ${url}`);
    }),
  );
  return calls;
}

function env(state = kv()) {
  const sent: { to: string; raw: string }[] = [];
  const e: GuardEnv = {
    STATE: state,
    ALERT_EMAIL: { send: async (m: { to: string; raw: string }) => void sent.push(m) } as unknown as SendEmail,
    ALERT_FROM: 'guard@example.com',
    ALERT_TO: 'a@example.com, b@example.com',
    GUARD_MODE: 'observe',
    CF_TOKEN_PRIMARY: 'p',
    CF_TOKEN_RESERVE: 'r',
  };
  return { e, sent, state };
}

const decodeSubject = (raw: string) => {
  const b64 = raw.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)![1]!;
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
};

describe('createGuardWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const controller = {} as ScheduledController;

  it('mails each recipient and sends the Cloudflare tokens', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubInternet({ blocked: ZONE_IPS });
    const { e, sent } = env();
    const worker = createGuardWorker(CONFIG, { label: 'Guard' });

    await worker.scheduled(controller, e);

    expect(sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(decodeSubject(sent[0]!.raw)).toBe('[observe] Guard: reserve ACTIVATED');
    const authorizations = (vi.mocked(fetch).mock.calls as [string, RequestInit][])
      .filter(([url]) => String(url).startsWith('https://api.cloudflare.com/'))
      .map(([, init]) => (init.headers as Record<string, string>).authorization);
    expect(new Set(authorizations)).toEqual(new Set(['Bearer p']));
  });

  it('reports only the third failed run in a row, and clears the count on success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubInternet({ apiFails: true });
    const { e, sent, state } = env();
    const worker = createGuardWorker(CONFIG, { label: 'Guard' });

    for (let i = 0; i < 3; i++) await expect(worker.scheduled(controller, e)).rejects.toThrow(/boom/);

    expect(sent.map((m) => decodeSubject(m.raw))).toEqual(['Guard: failing', 'Guard: failing']);
    stubInternet();
    await worker.scheduled(controller, e);
    expect((state as unknown as { data: Map<string, string> }).data.has('failures')).toBe(false);
  });

  it('token names are configurable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubInternet();
    const { e } = env();
    e.MY_PRIMARY = 'mine';
    const worker = createGuardWorker(CONFIG, { label: 'Guard', tokens: (env) => ({ primary: String(env.MY_PRIMARY), reserve: 'x' }) });

    await worker.scheduled(controller, e);

    const auth = (vi.mocked(fetch).mock.calls as [string, RequestInit][]).find(([url]) => String(url).includes('/dns_records'))![1];
    expect((auth.headers as Record<string, string>).authorization).toBe('Bearer mine');
  });
});
