import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMING, type GuardConfig } from '../src/config.js';
import { createGuard, type GuardDeps } from '../src/guard.js';
import { fakeCloudflare } from './fake-cloudflare.js';
import { CONFIG, NOW, RESERVE_IPS, ZONE_IPS } from './fixtures.js';

const { releaseAfterMs: RELEASE, ipMemoryMs: MEMORY } = DEFAULT_TIMING;
const FALLBACK = CONFIG.reserve.fallbackHost;

/** The blocklists, DoH and the reserve health check. */
function internet(opts: { blocked?: Record<string, string[]>; healthy?: boolean; zoneDns?: string[] }) {
  return vi.fn(async (input: string) => {
    const url = String(input);
    const isp = url.match(/blocked-(\w+)\.txt/)?.[1];
    if (isp) {
      return new Response((opts.blocked?.[isp] ?? []).join('\n'), {
        headers: { 'last-modified': new Date(NOW - 60_000).toUTCString() },
      });
    }
    if (url.includes('dns.google') || url.includes('dns-query')) {
      const ips = url.includes(CONFIG.primary.probeHost) ? (opts.zoneDns ?? ZONE_IPS) : RESERVE_IPS;
      return Response.json({ Answer: ips.map((data) => ({ type: 1, data })) });
    }
    if (url === CONFIG.reserve.healthUrl) return new Response('', { status: opts.healthy === false ? 530 : 200 });
    throw new Error(`not simulated: ${url}`);
  }) as unknown as typeof fetch;
}

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (async (k: string) => data.get(k) ?? null) as unknown as KVNamespace['get'],
    put: (async (k: string, v: string) => void data.set(k, v)) as unknown as KVNamespace['put'],
    delete: (async (k: string) => void data.delete(k)) as unknown as KVNamespace['delete'],
  };
}

function setup(opts: {
  zoneDns?: string[];
  blocked?: Record<string, string[]>;
  healthy?: boolean;
  active?: boolean;
  kv?: Record<string, string>;
  mode?: GuardDeps['mode'];
  hostnames?: Parameters<typeof fakeCloudflare>[0]['hostnames'];
  config?: GuardConfig;
}) {
  const cf = fakeCloudflare({
    domains: opts.active ? ['origin.example.com'] : ['example.com', 'www.example.com', 'origin.example.com'],
    records: opts.active
      ? ['example.com', 'www.example.com'].map((name) => ({ id: name, type: 'CNAME', name, content: FALLBACK }))
      : [],
    hostnames: opts.hostnames ?? [
      { id: 'a', hostname: 'example.com', status: 'pending' },
      { id: 'b', hostname: 'www.example.com', status: 'pending' },
    ],
  });
  const kv = memoryKv(opts.kv);
  const notify = vi.fn(async (_subject: string, _body: string) => {});
  const guard = createGuard(opts.config ?? CONFIG, 'Guard');
  const deps: GuardDeps = {
    apis: cf.apis,
    state: kv,
    notify,
    log: () => {},
    mode: opts.mode ?? 'auto',
    now: NOW,
    fetcher: internet(opts),
    runbook: 'docs/runbook.md',
  };
  const run = () => guard.run(deps);
  const subjects = () => notify.mock.calls.map(([subject]) => subject);
  return { cf, kv, notify, deps, run, subjects };
}

describe('guard', () => {
  it('without a block it touches nothing and says nothing', async () => {
    const { cf, run, subjects } = setup({});

    expect((await run()).action).toBe('stay');
    expect(cf.world.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    expect(subjects()).toEqual([]);
  });

  it('a block on one ISP activates the reserve, records when, and alerts', async () => {
    const { cf, kv, run, subjects, notify } = setup({ blocked: { movistar: [ZONE_IPS[0]!] } });

    expect((await run()).action).toBe('activate');
    expect(cf.world.records.map((r) => r.name).sort()).toEqual(['example.com', 'www.example.com']);
    expect(kv.data.get('lastBlockedAt')).toBe(String(NOW));
    expect(subjects()).toEqual(['Guard: reserve ACTIVATED']);
    expect(notify.mock.calls[0]![1]).toMatch(/Runbook: docs\/runbook\.md/);
  });

  it('in observe mode it decides and alerts but touches nothing', async () => {
    const { cf, run, subjects } = setup({ blocked: { digi: ZONE_IPS }, mode: 'observe' });

    expect((await run()).action).toBe('activate');
    expect(cf.world.records).toEqual([]);
    expect(subjects()).toEqual(['[observe] Guard: reserve ACTIVATED']);
  });

  it('in observe mode the same decision is not mailed every run', async () => {
    const { run, subjects } = setup({ blocked: { digi: ZONE_IPS }, mode: 'observe' });

    await run();
    await run();

    expect(subjects()).toEqual(['[observe] Guard: reserve ACTIVATED']);
  });

  it('after the margin without a block it goes back and forgets the date', async () => {
    const { cf, kv, run, subjects } = setup({ active: true, kv: { lastBlockedAt: String(NOW - RELEASE) } });

    expect((await run()).action).toBe('deactivate');
    expect(cf.world.records).toEqual([]);
    expect(cf.world.domains.map((d) => d.hostname).sort()).toEqual(['example.com', 'origin.example.com', 'www.example.com']);
    expect(subjects()).toEqual(['Guard: reserve deactivated']);
    expect(kv.data.has('lastBlockedAt')).toBe(false);
  });

  it('reserve activated by hand (no date stored): counts from now', async () => {
    const { kv, run } = setup({ active: true });

    expect((await run()).action).toBe('stay');
    expect(kv.data.get('lastBlockedAt')).toBe(String(NOW));
  });

  it('with the reserve off it forgets an old date: a later manual activation waits its margin', async () => {
    const off = setup({ kv: { lastBlockedAt: String(NOW - 36 * 3600_000) } });

    await off.run();

    expect(off.kv.data.has('lastBlockedAt')).toBe(false);
    const manual = setup({ active: true, kv: Object.fromEntries(off.kv.data) });
    expect((await manual.run()).action).toBe('stay');
  });

  it('a problem is alerted once, not every run', async () => {
    const { run, subjects } = setup({ blocked: { orange: ZONE_IPS }, healthy: false });

    await run();
    await run();

    expect(subjects()).toEqual(['Guard: problem']);
  });

  it('also watches IPs the guard resolves even if they are not seeded', async () => {
    const { kv, run } = setup({ zoneDns: ['203.0.113.40'], blocked: { vodafone: ['203.0.113.40'] } });

    expect((await run()).action).toBe('activate');
    expect(JSON.parse(kv.data.get('seenIps:zone')!)).toEqual({ '203.0.113.40': NOW });
  });

  it('remembers seen IPs for the memory window even if DNS stops returning them', async () => {
    const remembered = setup({
      blocked: { digi: ['203.0.113.40'] },
      kv: { 'seenIps:zone': JSON.stringify({ '203.0.113.40': NOW - MEMORY + 60_000 }) },
    });
    const forgotten = setup({
      blocked: { digi: ['203.0.113.40'] },
      kv: { 'seenIps:zone': JSON.stringify({ '203.0.113.40': NOW - MEMORY - 60_000 }) },
    });

    expect((await remembered.run()).action).toBe('activate');
    expect((await forgotten.run()).action).toBe('stay');
  });

  it('outside a block it keeps the reserve ready and reports what changed', async () => {
    const { cf, run, subjects } = setup({
      hostnames: [
        { id: 'a', hostname: 'example.com', status: 'moved' },
        { id: 'b', hostname: 'www.example.com', status: 'pending' },
      ],
    });

    await run();

    expect(cf.world.hostnames.find((h) => h.id === 'a')!.status).toBe('pending');
    expect(subjects()).toEqual(['Guard: reserve maintenance']);
  });

  it('speaks Spanish when asked', async () => {
    const { run, subjects, notify } = setup({ blocked: { movistar: ZONE_IPS }, config: { ...CONFIG, locale: 'es' } });

    await run();

    expect(subjects()).toEqual(['Guard: reserva ACTIVADA']);
    expect(notify.mock.calls[0]![1]).toMatch(/^example\.com sirve ahora desde fallback\.example\.net/);
  });
});
