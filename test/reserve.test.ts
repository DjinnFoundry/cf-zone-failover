import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '../src/config.js';
import { LOCALES } from '../src/messages.js';
import { createReserve } from '../src/reserve.js';
import { fakeCloudflare, normalCloudflare } from './fake-cloudflare.js';
import { DOCS, FALLBACK, RESOLVED, SHOP, TUNNEL } from './fixtures.js';

const say = LOCALES.en({ hosts: [], fallbackHost: '', healthUrl: '', blocklistName: '', workers: [] }).change;
type Cf = ReturnType<typeof fakeCloudflare>;

const reserveOf = (cf: Cf, site: SiteConfig) => createReserve(cf.apis, site, RESOLVED);
const cnames = (cf: Cf) => cf.world.records.filter((r) => r.content === FALLBACK).map((r) => r.name).sort();
const domains = (cf: Cf) => cf.world.domains.map((d) => d.hostname).sort();
const served = (cf: Cf, name: string) =>
  cf.world.records.filter((r) => r.name === name).map((r) => `${r.type} ${r.content} ${r.proxied ? 'proxied' : 'dns-only'}`);

describe('a Worker site', () => {
  it('activate: removes the public Custom Domains and adds the CNAMEs, leaving the origin alone', async () => {
    const cf = normalCloudflare();
    const reserve = reserveOf(cf, SHOP);

    await reserve.activate();

    expect(domains(cf)).toEqual(['origin.example.com']);
    expect(cnames(cf)).toEqual(['example.com', 'www.example.com']);
    expect(await reserve.isActive()).toBe(true);
    expect(await reserveOf(cf, DOCS).isActive()).toBe(false);
  });

  it('if it fails halfway it puts the Custom Domains back: never a name with nothing', async () => {
    const cf = normalCloudflare();
    cf.world.failOn = `POST /zones/${SHOP.zoneId}/dns_records`;

    await expect(reserveOf(cf, SHOP).activate()).rejects.toThrow(/simulated failure/);

    expect(domains(cf)).toEqual(['example.com', 'origin.example.com', 'www.example.com']);
    expect(cnames(cf)).toEqual([]);
  });

  it('deactivate: removes only its CNAMEs and reattaches the Custom Domains', async () => {
    const cf = normalCloudflare();
    cf.world.records.push({ id: 'check', zone: SHOP.zoneId, type: 'CNAME', name: 'reserve-check.example.com', content: FALLBACK });
    const reserve = reserveOf(cf, SHOP);
    await reserve.activate();

    await reserve.deactivate();

    expect(domains(cf)).toEqual(['example.com', 'origin.example.com', 'www.example.com']);
    expect(cnames(cf)).toEqual(['reserve-check.example.com']);
  });
});

describe('a site of Pages and origin records', () => {
  it('activate: replaces each public record with the CNAME and leaves the origin record alone', async () => {
    const cf = normalCloudflare();

    await reserveOf(cf, DOCS).activate();

    expect(served(cf, 'example.org')).toEqual([`CNAME ${FALLBACK} dns-only`]);
    expect(served(cf, 'app.example.org')).toEqual([`CNAME ${FALLBACK} dns-only`]);
    expect(served(cf, 'origin-app.example.org')).toEqual([`CNAME ${TUNNEL} proxied`]);
  });

  it('deactivate: Pages back to its project, the origin host back to what its origin record points at', async () => {
    const cf = normalCloudflare();
    const reserve = reserveOf(cf, DOCS);
    await reserve.activate();

    await reserve.deactivate();

    expect(served(cf, 'example.org')).toEqual(['CNAME example-docs.pages.dev proxied']);
    expect(served(cf, 'app.example.org')).toEqual([`CNAME ${TUNNEL} proxied`]);
    expect(await reserve.isActive()).toBe(false);
  });

  it('a Pages project with a suffixed pages.dev name goes back to that name, and its API name is the project', async () => {
    const cf = normalCloudflare({ pages: { 'example.org': 'deactivated' } });
    cf.world.records.find((r) => r.name === 'example.org')!.content = 'example-docs-a1b.pages.dev';
    const suffixed: SiteConfig = {
      ...DOCS,
      hosts: [{ name: 'example.org', via: 'pages', project: 'example-docs', subdomain: 'example-docs-a1b.pages.dev' }],
    };
    const reserve = reserveOf(cf, suffixed);
    await reserve.activate();
    await reserve.deactivate();

    expect(served(cf, 'example.org')).toEqual(['CNAME example-docs-a1b.pages.dev proxied']);
    await reserve.maintain(say);
    expect(cf.world.calls).toContain(`PATCH /accounts/${DOCS.accountId}/pages/projects/example-docs/domains/example.org`);
  });

  it('a failure halfway puts every record back', async () => {
    const cf = normalCloudflare();
    const reserve = reserveOf(cf, DOCS);
    // The second CNAME fails: example.org already moved, app.example.org already lost its record.
    let posts = 0;
    const flaky = (async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && ++posts === 2) throw new Error('simulated failure');
      return cf.api(method, path, body);
    }) as typeof cf.api;

    await expect(createReserve({ zone: flaky, reserve: cf.api }, DOCS, RESOLVED).activate()).rejects.toThrow(/simulated/);

    expect(served(cf, 'example.org')).toEqual(['CNAME example-docs.pages.dev proxied']);
    expect(served(cf, 'app.example.org')).toEqual([`CNAME ${TUNNEL} proxied`]);
    expect(await reserve.isActive()).toBe(false);
  });
});

describe('maintain', () => {
  const txt = (name: string, value: string, comment = RESOLVED.dns.txtComment) => ({
    zone: SHOP.zoneId,
    type: 'TXT',
    name,
    content: `"${value}"`,
    comment,
  });

  it('does nothing when everything is in place', async () => {
    const cf = normalCloudflare();

    expect(await reserveOf(cf, SHOP).maintain(say)).toEqual([]);
    expect(await reserveOf(cf, DOCS).maintain(say)).toEqual([]);
    expect(cf.world.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('creates the Worker origin, the origin record and the probe a new site lacks', async () => {
    const cf = fakeCloudflare({
      domains: [{ account: SHOP.accountId, hostname: 'example.com', service: 'site' }, { account: SHOP.accountId, hostname: 'www.example.com', service: 'site' }],
      records: [
        { zone: DOCS.zoneId, type: 'CNAME', name: 'example.org', content: 'example-docs.pages.dev', proxied: true },
        { zone: DOCS.zoneId, type: 'CNAME', name: 'app.example.org', content: TUNNEL, proxied: true },
      ],
      hostnames: ['example.com', 'www.example.com', 'example.org', 'app.example.org'].map((hostname, i) => ({ id: `h${i}`, hostname, status: 'active' })),
    });
    const pagesOnly: SiteConfig = { ...DOCS, id: 'only-pages', hosts: [DOCS.hosts[0]!], probeHost: 'probe.example.org' };

    expect(await reserveOf(cf, SHOP).maintain(say)).toEqual(['origin.example.com created']);
    expect(await reserveOf(cf, DOCS).maintain(say)).toEqual(['origin-app.example.org created']);
    expect(await reserveOf(cf, pagesOnly).maintain(say)).toEqual(['probe.example.org created']);
    expect(cf.world.domains.find((d) => d.hostname === 'origin.example.com')!.service).toBe('site');
    expect(served(cf, 'origin-app.example.org')).toEqual([`CNAME ${TUNNEL} proxied`]);
    expect(served(cf, 'probe.example.org')).toEqual(['AAAA 100:: proxied']);
  });

  it('repairs a return left halfway: a public name with nothing is put back', async () => {
    const cf = normalCloudflare();
    cf.world.domains = cf.world.domains.filter((d) => d.hostname !== 'www.example.com');
    cf.world.records = cf.world.records.filter((r) => r.name !== 'example.org');

    expect(await reserveOf(cf, SHOP).maintain(say)).toEqual(['www.example.com was not served from the zone: put back']);
    expect(await reserveOf(cf, DOCS).maintain(say)).toEqual(['example.org was not served from the zone: put back']);
    expect(domains(cf)).toContain('www.example.com');
    expect(served(cf, 'example.org')).toEqual(['CNAME example-docs.pages.dev proxied']);
  });

  it('retries the validation of a Pages domain that lost it, and leaves a pending one alone', async () => {
    const lost = normalCloudflare({ pages: { 'example.org': 'deactivated' } });
    const pending = normalCloudflare({ pages: { 'example.org': 'pending' } });

    expect(await reserveOf(lost, DOCS).maintain(say)).toEqual(['Pages domain example.org was deactivated: validation retried']);
    expect(lost.world.pages['example.org']).toBe('pending');
    expect(await reserveOf(pending, DOCS).maintain(say)).toEqual([]);
  });

  it('reactivates custom hostnames in moved and recreates deleted ones', async () => {
    const cf = normalCloudflare({
      hostnames: [
        { id: 'a', hostname: 'example.com', status: 'moved' },
        { id: 'b', hostname: 'example.org', status: 'pending' },
      ],
    });

    expect(await reserveOf(cf, SHOP).maintain(say)).toEqual([
      'custom hostname example.com reactivated from moved',
      'custom hostname www.example.com recreated',
    ]);
    expect(cf.world.hostnames.find((h) => h.id === 'a')!.status).toBe('pending');
  });

  it('reads every page of custom hostnames', async () => {
    const others = Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, hostname: `h${i}.example.net`, status: 'active' }));
    const cf = normalCloudflare({
      hostnames: [...others, ...['example.com', 'www.example.com'].map((hostname, i) => ({ id: `s${i}`, hostname, status: 'active' }))],
    });

    expect(await reserveOf(cf, SHOP).maintain(say)).toEqual([]);
  });

  it('adds the TXT records of a renewal in the site zone and removes only the reserve old ones', async () => {
    const cf = normalCloudflare({
      hostnames: [
        {
          id: 'a',
          hostname: 'example.com',
          status: 'pending',
          ssl: { validation_records: [{ txt_name: '_acme-challenge.example.com', txt_value: 'new' }] },
          ownership_verification: { type: 'txt', name: '_cf-custom-hostname.example.com', value: 'ownership' },
        },
        { id: 'b', hostname: 'www.example.com', status: 'pending' },
      ],
    });
    cf.world.records.push(
      ...[
        txt('_acme-challenge.example.com', 'old'),
        txt('_acme-challenge.example.com', 'zone-own-certificate', ''),
        txt('_cf-custom-hostname.example.com', 'ownership'),
      ].map((r, i) => ({ ...r, id: `t${i}` })),
    );

    const changes = await reserveOf(cf, SHOP).maintain(say);

    expect(changes).toEqual(['TXT _acme-challenge.example.com added', 'stale TXT _acme-challenge.example.com removed']);
    const shopTxt = cf.world.records.filter((r) => r.zone === SHOP.zoneId && r.type === 'TXT');
    expect(shopTxt.map((r) => r.content).sort()).toEqual(['"new"', '"ownership"', '"zone-own-certificate"']);
  });
});
