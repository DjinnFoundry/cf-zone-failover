import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMING, type FailoverConfig } from '../src/config.js';
import { createGuard, type GuardDeps } from '../src/guard.js';
import { createReserve } from '../src/reserve.js';
import { normalCloudflare } from './fake-cloudflare.js';
import { CONFIG, DOCS, DOCS_IPS, FALLBACK, NOW, RESERVE_IPS, SHOP, ZONE_IPS } from './fixtures.js';

const { releaseAfterMs: RELEASE, ipMemoryMs: MEMORY } = DEFAULT_TIMING;

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
      const ips = url.includes(SHOP.probeHost) ? (opts.zoneDns ?? ZONE_IPS) : url.includes(DOCS.probeHost) ? DOCS_IPS : RESERVE_IPS;
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
  /** Sites whose reserve is active at the start. */
  active?: string[];
  kv?: Record<string, string>;
  mode?: GuardDeps['mode'];
  hostnames?: NonNullable<Parameters<typeof normalCloudflare>[0]>['hostnames'];
  config?: FailoverConfig;
}) {
  const cf = normalCloudflare({ hostnames: opts.hostnames });
  const config = opts.config ?? CONFIG;
  const kv = memoryKv(opts.kv);
  const notify = vi.fn(async (_subject: string, _body: string) => {});
  const guard = createGuard(config, 'Guard');
  const deps: GuardDeps = {
    apis: { reserve: cf.api, site: () => cf.api },
    state: kv,
    notify,
    log: () => {},
    mode: opts.mode ?? 'auto',
    now: NOW,
    fetcher: internet(opts),
    runbook: 'docs/runbook.md',
  };
  const run = () => guard.run(deps);
  const decisions = async () => Object.fromEntries((await run()).map((o) => [o.site, o.decision?.action]));
  const subjects = () => notify.mock.calls.map(([subject]) => subject);
  return { cf, kv, notify, deps, run, decisions, subjects, guard };
}

/** Puts the reserve of these sites on before the test runs. */
async function activated(s: ReturnType<typeof setup>, ids: string[]) {
  for (const site of CONFIG.sites.filter((x) => ids.includes(x.id))) {
    await createReserve({ zone: s.cf.api, reserve: s.cf.api }, site, s.guard.config).activate();
  }
  s.cf.world.calls = [];
  return s;
}

const cnames = (s: ReturnType<typeof setup>) => s.cf.world.records.filter((r) => r.content === FALLBACK).map((r) => r.name).sort();

describe('guard', () => {
  it('without a block it touches nothing and says nothing', async () => {
    const s = setup({});

    expect(await s.decisions()).toEqual({ shop: 'stay', docs: 'stay' });
    expect(s.cf.world.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    expect(s.subjects()).toEqual([]);
  });

  it('decides per zone: only the blocked site moves', async () => {
    const s = setup({ blocked: { movistar: [ZONE_IPS[0]!] } });

    expect(await s.decisions()).toEqual({ shop: 'activate', docs: 'stay' });
    expect(cnames(s)).toEqual(['example.com', 'www.example.com']);
    expect(s.kv.data.get('shop:lastBlockedAt')).toBe(String(NOW));
    expect(s.kv.data.has('docs:lastBlockedAt')).toBe(false);
  });

  it('several sites moving in one run make one mail', async () => {
    const s = setup({ blocked: { digi: [...ZONE_IPS, ...DOCS_IPS] } });

    await s.run();

    expect(cnames(s)).toEqual(['app.example.org', 'example.com', 'example.org', 'www.example.com']);
    expect(s.subjects()).toEqual(['Guard: reserve ACTIVATED (shop, docs)']);
    const body = s.notify.mock.calls[0]![1];
    expect(body).toMatch(/^example\.com, www\.example\.com: now served from fallback\.example\.net\.\n\nDo not deploy site/);
    expect(body).toMatch(/example\.org, app\.example\.org: now served from fallback\.example\.net\.\n\nzone blocked by digi\./);
    expect(body).toMatch(/Runbook: docs\/runbook\.md/);
  });

  it('one failing site does not stop the others, and the run fails after all of them ran', async () => {
    const s = setup({ blocked: { digi: [...ZONE_IPS, ...DOCS_IPS] } });
    s.cf.world.failOn = `GET /accounts/${SHOP.accountId}/workers/domains`;

    await expect(s.run()).rejects.toThrow(/^shop: simulated failure/);

    expect(cnames(s)).toEqual(['app.example.org', 'example.org']);
    expect(s.subjects()).toEqual(['Guard: reserve ACTIVATED (docs)']);
  });

  it('in observe mode it decides and alerts but touches nothing, once', async () => {
    const s = setup({ blocked: { digi: ZONE_IPS }, mode: 'observe' });

    expect((await s.decisions()).shop).toBe('activate');
    await s.run();

    expect(cnames(s)).toEqual([]);
    expect(s.subjects()).toEqual(['[observe] Guard: reserve ACTIVATED (shop)']);
  });

  it('a site in observe stays untouched while the others act', async () => {
    const config = { ...CONFIG, sites: [SHOP, { ...DOCS, observe: true }] };
    const s = setup({ blocked: { digi: [...ZONE_IPS, ...DOCS_IPS] }, config });

    await s.run();

    expect(cnames(s)).toEqual(['example.com', 'www.example.com']);
    expect(s.subjects()).toEqual(['Guard: reserve ACTIVATED (shop)', '[observe] Guard: reserve ACTIVATED (docs)']);
  });

  it('after the margin without a block it goes back and forgets the date', async () => {
    const s = await activated(setup({ kv: { 'shop:lastBlockedAt': String(NOW - RELEASE) } }), ['shop']);

    expect((await s.decisions()).shop).toBe('deactivate');
    expect(cnames(s)).toEqual([]);
    expect(s.cf.world.domains.map((d) => d.hostname).sort()).toEqual(['example.com', 'origin.example.com', 'www.example.com']);
    expect(s.subjects()).toEqual(['Guard: reserve deactivated (shop)']);
    expect(s.kv.data.has('shop:lastBlockedAt')).toBe(false);
  });

  it('reserve activated by hand (no date stored): counts from now', async () => {
    const s = await activated(setup({}), ['docs']);

    expect((await s.decisions()).docs).toBe('stay');
    expect(s.kv.data.get('docs:lastBlockedAt')).toBe(String(NOW));
  });

  it('with the reserve off it forgets an old date: a later manual activation waits its margin', async () => {
    const off = setup({ kv: { 'shop:lastBlockedAt': String(NOW - 36 * 3600_000) } });

    await off.run();

    expect(off.kv.data.has('shop:lastBlockedAt')).toBe(false);
    const manual = await activated(setup({ kv: Object.fromEntries(off.kv.data) }), ['shop']);
    expect((await manual.decisions()).shop).toBe('stay');
  });

  it('a problem shared by every site is alerted once, not per site nor per run', async () => {
    const s = setup({ blocked: { orange: [...ZONE_IPS, ...DOCS_IPS] }, healthy: false });

    await s.run();
    await s.run();

    expect(s.subjects()).toEqual(['Guard: problem']);
  });

  it('also watches IPs the guard resolves even if they are not seeded', async () => {
    const s = setup({ zoneDns: ['203.0.113.40'], blocked: { vodafone: ['203.0.113.40'] } });

    expect((await s.decisions()).shop).toBe('activate');
    expect(JSON.parse(s.kv.data.get('shop:seenIps')!)).toEqual({ '203.0.113.40': NOW });
  });

  it('remembers seen IPs for the memory window even if DNS stops returning them', async () => {
    const seen = (at: number) => ({ 'shop:seenIps': JSON.stringify({ '203.0.113.40': at }) });
    const remembered = setup({ blocked: { digi: ['203.0.113.40'] }, kv: seen(NOW - MEMORY + 60_000) });
    const forgotten = setup({ blocked: { digi: ['203.0.113.40'] }, kv: seen(NOW - MEMORY - 60_000) });

    expect((await remembered.decisions()).shop).toBe('activate');
    expect((await forgotten.decisions()).shop).toBe('stay');
  });

  it('outside a block it keeps every site ready, and does not repeat the same maintenance mail', async () => {
    const s = setup({
      hostnames: [
        { id: 'a', hostname: 'example.com', status: 'moved' },
        { id: 'b', hostname: 'www.example.com', status: 'pending' },
        { id: 'c', hostname: 'example.org', status: 'pending' },
        { id: 'd', hostname: 'app.example.org', status: 'pending' },
      ],
    });

    await s.run();
    s.cf.world.hostnames.find((h) => h.id === 'a')!.status = 'moved';
    await s.run();

    expect(s.subjects()).toEqual(['Guard: reserve maintenance (shop)']);
  });

  it('speaks Spanish when asked', async () => {
    const s = setup({ blocked: { movistar: ZONE_IPS }, config: { ...CONFIG, locale: 'es' } });

    await s.run();

    expect(s.subjects()).toEqual(['Guard: reserva ACTIVADA (shop)']);
    expect(s.notify.mock.calls[0]![1]).toMatch(/^example\.com, www\.example\.com: sirve ahora desde fallback\.example\.net/);
  });
});
