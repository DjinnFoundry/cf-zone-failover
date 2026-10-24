import { describe, expect, it } from 'vitest';
import { createSigning } from '../src/signing.js';

const SECRET = 'test-secret';
const signing = createSigning({
  originHost: 'origin.example.com',
  publicHosts: ['example.com', 'www.example.com'],
  testHostPattern: /^[a-z0-9-]+\.example\.com$/,
});
const { headers, toFallbackOrigin, fromFallbackProxy } = signing;

function visit(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { 'cf-connecting-ip': '203.0.113.7', cookie: 'a=1', ...init.headers } });
}

describe('toFallbackOrigin: the reserve forwards to the origin', () => {
  it('sends path, query, method and body to the origin host', async () => {
    const request = toFallbackOrigin(visit('https://example.com/login?x=1', { method: 'POST', body: 'hello' }), SECRET)!;

    expect(request.url).toBe('https://origin.example.com/login?x=1');
    expect(request.method).toBe('POST');
    expect(await request.text()).toBe('hello');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('cookie')).toBe('a=1');
  });

  it('signs it and passes the public host and the visitor IP', () => {
    const request = toFallbackOrigin(visit('https://www.example.com/'), SECRET)!;

    expect(request.headers.get(headers.secret)).toBe(SECRET);
    expect(request.headers.get(headers.publicHost)).toBe('www.example.com');
    expect(request.headers.get(headers.clientIp)).toBe('203.0.113.7');
  });

  it('a test hostname enters as the default public host', () => {
    const request = toFallbackOrigin(visit('https://reserve-check.example.com/'), SECRET)!;

    expect(request.headers.get(headers.publicHost)).toBe('example.com');
  });

  it.each(['https://fallback.example.net/', 'https://evil.test/', 'https://example.com.evil.test/'])(
    'does not forward foreign hosts: %s',
    (url) => {
      expect(toFallbackOrigin(visit(url), SECRET)).toBeNull();
    },
  );

  it('without a test pattern only the public hosts pass', () => {
    const strict = createSigning({ originHost: 'origin.example.com', publicHosts: ['example.com'] });

    expect(strict.toFallbackOrigin(visit('https://reserve-check.example.com/'), SECRET)).toBeNull();
  });

  it('the header prefix is configurable', () => {
    const custom = createSigning({ originHost: 'o.example.com', publicHosts: ['example.com'], headerPrefix: 'x-acme' });

    expect(custom.headers).toEqual({
      secret: 'x-acme-fallback-secret',
      publicHost: 'x-acme-public-host',
      clientIp: 'x-acme-client-ip',
    });
  });
});

describe('fromFallbackProxy: the origin undoes the hand-off', () => {
  const proxied = (init: { secret?: string; host?: string; path?: string } = {}) =>
    toFallbackOrigin(visit(`https://${init.host ?? 'example.com'}${init.path ?? '/'}`), init.secret ?? SECRET)!;

  it('does nothing outside the origin host', () => {
    expect(fromFallbackProxy(visit('https://example.com/'), SECRET)).toBeNull();
  });

  it('returns the request as if it had reached its public host, with the visitor IP', () => {
    const request = fromFallbackProxy(proxied({ host: 'www.example.com', path: '/blog?p=2' }), SECRET) as Request;

    expect(request.url).toBe('https://www.example.com/blog?p=2');
    expect(request.headers.get('cf-connecting-ip')).toBe('203.0.113.7');
    expect(request.headers.get('cookie')).toBe('a=1');
    for (const header of Object.values(headers)) expect(request.headers.has(header)).toBe(false);
  });

  it('rewrites the Host header too: frameworks build the URL from it', () => {
    // With the origin's Host, OpenNext took every middleware rewrite for an
    // external one and the Worker fetched itself over the internet.
    const arrived = proxied({ host: 'www.example.com' });
    arrived.headers.set('host', 'origin.example.com');

    const request = fromFallbackProxy(arrived, SECRET) as Request;

    expect(request.headers.get('host')).toBe('www.example.com');
  });

  it.each([
    ['no secret on the origin', undefined, SECRET],
    ['a wrong secret', SECRET, 'another-secret'],
  ])('answers 404 with %s', (_case, originSecret, proxySecret) => {
    const response = fromFallbackProxy(proxied({ secret: proxySecret }), originSecret);

    expect((response as Response).status).toBe(404);
  });

  it('answers 404 to a direct request to the origin host', () => {
    expect((fromFallbackProxy(visit('https://origin.example.com/'), SECRET) as Response).status).toBe(404);
  });

  it('answers 404 if the signed public host is not ours', () => {
    const request = proxied();
    request.headers.set(headers.publicHost, 'evil.test');

    expect((fromFallbackProxy(request, SECRET) as Response).status).toBe(404);
  });
});
