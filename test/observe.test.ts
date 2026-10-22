import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RESOLVERS, DEFAULT_TIMING, HAYAHORA } from '../src/config.js';
import { blockingIsps, readBlocklists, reserveHealthy, resolveA } from '../src/observe.js';
import { NOW } from './fixtures.js';

const MAX_AGE = DEFAULT_TIMING.maxListAgeMs;
const read = (fetcher: typeof fetch) => readBlocklists(HAYAHORA, { now: NOW, maxAgeMs: MAX_AGE }, fetcher);
const list = (body: string, modified = NOW - 60_000) =>
  new Response(body, { headers: { 'last-modified': new Date(modified).toUTCString() } });

describe('blocklists', () => {
  it('reads one IP per line and matches against ours', async () => {
    const fetcher = vi.fn(async (url: string) => list(url.includes('movistar') ? '192.0.2.5\n203.0.113.1\n' : '')) as unknown as typeof fetch;

    const lists = await read(fetcher);

    expect(lists.fresh).toBe(true);
    expect(blockingIsps(lists, ['192.0.2.5', '192.0.2.6'])).toEqual(['movistar']);
    expect(blockingIsps(lists, ['198.51.100.8'])).toEqual([]);
  });

  it('a list that is old, down or unreachable makes the whole read stale', async () => {
    const old = vi.fn(async (url: string) => list('', url.includes('digi') ? NOW - MAX_AGE - 1 : NOW)) as unknown as typeof fetch;
    const down = vi.fn(async (url: string) => (url.includes('orange') ? new Response('', { status: 503 }) : list(''))) as unknown as typeof fetch;
    const offline = vi.fn(async (url: string) => {
      if (url.includes('vodafone')) throw new TypeError('fetch failed');
      return list('');
    }) as unknown as typeof fetch;

    expect((await read(old)).fresh).toBe(false);
    expect((await read(down)).fresh).toBe(false);
    expect((await read(offline)).fresh).toBe(false);
  });

  it('a list without Last-Modified is not trusted', async () => {
    expect((await read((async () => new Response('')) as unknown as typeof fetch)).fresh).toBe(false);
  });

  it('any source with the same shape works', async () => {
    const source = { name: 'mine', isps: ['a', 'b'], url: (isp: string) => `https://lists.example.org/${isp}` };
    const fetcher = vi.fn(async (url: string) => list(url.endsWith('/b') ? '192.0.2.5' : '')) as unknown as typeof fetch;

    const lists = await readBlocklists(source, { now: NOW, maxAgeMs: MAX_AGE }, fetcher);

    expect(blockingIsps(lists, ['192.0.2.5'])).toEqual(['b']);
  });
});

describe('resolveA', () => {
  it('joins the resolvers answers and keeps only A records', async () => {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toMatch(/\?name=origin\.example\.com&type=A$/);
      const ip = url.includes('dns.google') ? '192.0.2.5' : '192.0.2.2';
      return Response.json({ Answer: [{ type: 5, data: 'x.' }, { type: 1, data: ip }] });
    }) as unknown as typeof fetch;

    expect(await resolveA('origin.example.com', DEFAULT_RESOLVERS, fetcher)).toEqual(['192.0.2.2', '192.0.2.5']);
  });

  it('returns empty instead of failing the run when DNS does not answer', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 502 })) as unknown as typeof fetch;

    expect(await resolveA('origin.example.com', DEFAULT_RESOLVERS, fetcher)).toEqual([]);
  });
});

describe('reserveHealthy', () => {
  const url = 'https://reserve-check.example.com/';
  it('healthy only on a 200', async () => {
    expect(await reserveHealthy(url, (async () => new Response('ok')) as unknown as typeof fetch)).toBe(true);
    expect(await reserveHealthy(url, (async () => new Response('', { status: 530 })) as unknown as typeof fetch)).toBe(false);
    expect(await reserveHealthy(url, (async () => { throw new Error('dns'); }) as unknown as typeof fetch)).toBe(false);
  });
});
