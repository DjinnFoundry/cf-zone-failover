import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/messages.js';
import { createReserve } from '../src/reserve.js';
import { fakeCloudflare } from './fake-cloudflare.js';
import { RESOLVED } from './fixtures.js';

const FALLBACK = RESOLVED.reserve.fallbackHost;
const say = LOCALES.en({ publicHost: '', fallbackHost: '', healthUrl: '', blocklistName: '', worker: '' }).change;
type World = ReturnType<typeof fakeCloudflare>['world'];

const normal = () => fakeCloudflare({ domains: ['example.com', 'www.example.com', 'origin.example.com'] });
const reserveOf = (cf: ReturnType<typeof fakeCloudflare>) => createReserve(cf.apis, RESOLVED);
const cnames = (world: World) => world.records.filter((r) => r.type === 'CNAME' && r.content === FALLBACK).map((r) => r.name).sort();
const domains = (world: World) => world.domains.map((d) => d.hostname).sort();

describe('activate and deactivate', () => {
  it('activate: removes the public Custom Domains and adds the CNAMEs, leaving the origin host alone', async () => {
    const cf = normal();
    const reserve = reserveOf(cf);

    await reserve.activate();

    expect(domains(cf.world)).toEqual(['origin.example.com']);
    expect(cnames(cf.world)).toEqual(['example.com', 'www.example.com']);
    expect(cf.world.records.every((r) => r.comment === RESOLVED.dns.cnameComment)).toBe(true);
    expect(await reserve.isActive()).toBe(true);
  });

  it('if it fails halfway it puts the Custom Domains back: never a name with nothing', async () => {
    const cf = normal();
    cf.world.failOn = 'POST /zones/';

    await expect(reserveOf(cf).activate()).rejects.toThrow(/simulated failure/);

    expect(domains(cf.world)).toEqual(['example.com', 'origin.example.com', 'www.example.com']);
    expect(cnames(cf.world)).toEqual([]);
  });

  it('deactivate: removes only the public CNAMEs and reattaches the Custom Domains', async () => {
    const cf = normal();
    cf.world.records.push({ id: 'check', type: 'CNAME', name: 'reserve-check.example.com', content: FALLBACK });
    const reserve = reserveOf(cf);
    await reserve.activate();

    await reserve.deactivate();

    expect(domains(cf.world)).toEqual(['example.com', 'origin.example.com', 'www.example.com']);
    expect(cf.world.records.map((r) => r.name)).toEqual(['reserve-check.example.com']);
    expect(await reserve.isActive()).toBe(false);
  });
});

describe('maintain', () => {
  const txt = (name: string, value: string, comment = RESOLVED.dns.txtComment) => ({
    id: `${name}:${value}`,
    type: 'TXT',
    name,
    content: `"${value}"`,
    comment,
  });

  it('reactivates custom hostnames in moved and leaves pending ones alone', async () => {
    const cf = fakeCloudflare({
      hostnames: [
        { id: 'a', hostname: 'example.com', status: 'moved' },
        { id: 'b', hostname: 'www.example.com', status: 'pending' },
      ],
    });

    expect(await reserveOf(cf).maintain(say)).toEqual(['custom hostname example.com reactivated from moved']);
    expect(cf.world.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
  });

  it('recreates the custom hostname Cloudflare already deleted', async () => {
    const cf = fakeCloudflare({ hostnames: [{ id: 'b', hostname: 'www.example.com', status: 'pending' }] });

    expect(await reserveOf(cf).maintain(say)).toEqual(['custom hostname example.com recreated']);
    expect(cf.world.hostnames.map((h) => h.hostname)).toContain('example.com');
  });

  it('adds the TXT records of a renewal and removes only the reserve old ones', async () => {
    const cf = fakeCloudflare({
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
      records: [
        txt('_acme-challenge.example.com', 'old'),
        txt('_acme-challenge.example.com', 'zone-own-certificate', ''),
        txt('_cf-custom-hostname.example.com', 'ownership'),
      ],
    });

    const changes = await reserveOf(cf).maintain(say);

    expect(changes).toEqual(['TXT _acme-challenge.example.com added', 'stale TXT _acme-challenge.example.com removed']);
    expect(cf.world.records.map((r) => r.content).sort()).toEqual(['"new"', '"ownership"', '"zone-own-certificate"']);
  });

  it('does not touch DNS when there is nothing to validate', async () => {
    const cf = fakeCloudflare({
      hostnames: [
        { id: 'a', hostname: 'example.com', status: 'active' },
        { id: 'b', hostname: 'www.example.com', status: 'active' },
      ],
      records: [txt('_acme-challenge.example.com', 'old')],
    });

    expect(await reserveOf(cf).maintain(say)).toEqual([]);
    expect(cf.world.records).toHaveLength(1);
  });
});
