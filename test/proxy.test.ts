import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFailoverProxy } from '../src/proxy-worker.js';
import { createSigning } from '../src/signing.js';
import { CONFIG, DOCS, SHOP } from './fixtures.js';

const proxy = createFailoverProxy(CONFIG);
const env = { FALLBACK_SECRET_SHOP: 'shop-secret' };
const shopHeaders = createSigning({ originHost: 'origin.example.com', publicHosts: ['example.com'] }).headers;

function upstream(response: () => Response = () => new Response('hi')) {
  const fetchMock = vi.fn(async (_input: Request | string, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', fetchMock);
  /** What the proxy sent, as a Request (built once: its body can only be read once). */
  const built = new Map<number, Request>();
  const sent = (i = 0) => {
    if (!built.has(i)) {
      const [input, init] = fetchMock.mock.calls[i]!;
      built.set(i, typeof input === 'string' ? new Request(input, init) : input);
    }
    return built.get(i)!;
  };
  return { fetchMock, sent };
}

const visit = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { 'cf-connecting-ip': '203.0.113.7', cookie: 'a=1', ...init.headers } });

describe('createFailoverProxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a Worker host goes to its origin, signed with its site secret, and the response comes back as is', async () => {
    const { sent } = upstream(() => new Response('hi', { status: 302, headers: { location: 'https://example.com/' } }));

    const response = await proxy.fetch(visit('https://www.example.com/?a=1'), env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/');
    expect(sent().url).toBe('https://origin.example.com/?a=1');
    expect(sent().headers.get(shopHeaders.secret)).toBe('shop-secret');
    expect(sent().headers.get(shopHeaders.publicHost)).toBe('www.example.com');
  });

  it('a site test hostname enters as its first host', async () => {
    const { sent } = upstream();

    await proxy.fetch(visit('https://reserve-check.example.com/'), env);

    expect(sent().headers.get(shopHeaders.publicHost)).toBe('example.com');
  });

  it('a Pages host is fetched from pages.dev with path, method and body, and its own headers come back', async () => {
    const { sent } = upstream(() => new Response('page', { headers: { 'x-robots-tag': 'noindex', 'content-type': 'text/html' } }));

    const response = await proxy.fetch(visit('https://example.org/contact?x=1', { method: 'POST', body: 'hello' }), env);

    expect(sent().url).toBe('https://example-docs.pages.dev/contact?x=1');
    expect(sent().method).toBe('POST');
    expect(await sent().text()).toBe('hello');
    expect(sent().headers.get('x-forwarded-host')).toBe('example.org');
    expect(sent().headers.get('cookie')).toBe('a=1');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(await response.text()).toBe('page');
  });

  it('a Pages project with a suffixed pages.dev name is fetched there', async () => {
    const { sent } = upstream();
    const suffixed = createFailoverProxy({
      ...CONFIG,
      sites: [{ ...DOCS, hosts: [{ name: 'example.org', via: 'pages', project: 'example-docs', subdomain: 'example-docs-a1b.pages.dev' }] }],
    });

    await suffixed.fetch(visit('https://example.org/'), env);

    expect(sent().url).toBe('https://example-docs-a1b.pages.dev/');
  });

  it('absolute redirects to the target go back to the public name; others are left alone', async () => {
    const redirect = (location: string) => () => new Response(null, { status: 301, headers: { location } });

    upstream(redirect('https://example-docs.pages.dev/about/'));
    expect((await proxy.fetch(visit('https://example.org/about'), env)).headers.get('location')).toBe('https://example.org/about/');

    upstream(redirect('/about/'));
    expect((await proxy.fetch(visit('https://example.org/about'), env)).headers.get('location')).toBe('/about/');

    upstream(redirect('https://login.example.net/'));
    expect((await proxy.fetch(visit('https://app.example.org/'), env)).headers.get('location')).toBe('https://login.example.net/');
  });

  it('an origin host is fetched from its origin record, keeping its own headers', async () => {
    const { sent } = upstream(() => new Response('app', { headers: { 'x-robots-tag': 'noindex' } }));

    const response = await proxy.fetch(visit('https://app.example.org/dashboard'), env);

    expect(sent().url).toBe('https://origin-app.example.org/dashboard');
    expect(sent().redirect).toBe('manual');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('answers 404 to foreign hosts, such as the fallback host asked directly', async () => {
    const { fetchMock } = upstream();

    expect((await proxy.fetch(visit('https://fallback.example.net/'), env)).status).toBe(404);
    expect((await proxy.fetch(visit('https://example.com.evil.test/'), env)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a Worker host without its secret is not forwarded; the other sites still are', async () => {
    const { fetchMock } = upstream();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await proxy.fetch(visit('https://example.com/'), {})).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await proxy.fetch(visit('https://example.org/'), {})).status).toBe(200);
  });

  it('the secret variable can be named per site', async () => {
    const { sent } = upstream();
    const custom = createFailoverProxy({ ...CONFIG, sites: [{ ...SHOP, secretEnv: 'LEGACY_SECRET' }] });

    await custom.fetch(visit('https://example.com/'), { LEGACY_SECRET: 'old' });

    expect(sent().headers.get(shopHeaders.secret)).toBe('old');
  });
});

describe('config validation', () => {
  const site = (over: object) => ({ ...CONFIG, sites: [{ ...SHOP, ...over }] });

  it.each([
    ['no sites', { ...CONFIG, sites: [] }, /no sites/],
    ['a bad id', site({ id: 'Shop!' }), /site id/],
    ['a repeated host', { ...CONFIG, sites: [SHOP, { ...SHOP, id: 'other' }] }, /example\.com is in more than one site/],
    ['a probe that moves', site({ probeHost: 'example.com' }), /cannot be a probe or a target/],
  ])('rejects %s', (_case, config, error) => {
    expect(() => createFailoverProxy(config)).toThrow(error);
  });
});
