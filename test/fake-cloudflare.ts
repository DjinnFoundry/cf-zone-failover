// Tests only: the part of the Cloudflare API the guard touches, in memory, for any zone and account.
import type { CfApi } from '../src/cloudflare.js';
import { DOCS, SHOP, TUNNEL } from './fixtures.js';

export interface FakeRecord {
  id: string;
  zone: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}
export interface FakeDomain {
  id: string;
  account: string;
  hostname: string;
  service: string;
}
export interface FakeHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { validation_records?: { txt_name?: string; txt_value?: string }[] };
  ownership_verification?: { type?: string; name?: string; value?: string };
}

type Seed<T> = Omit<T, 'id'> & { id?: string };

export function fakeCloudflare(initial: {
  records?: Seed<FakeRecord>[];
  domains?: Seed<FakeDomain>[];
  hostnames?: FakeHostname[];
  /** Pages domain → status. */
  pages?: Record<string, string>;
}) {
  let seq = 0;
  const nextId = () => `id${++seq}`;
  const withId = <T extends { id?: string }>(x: T) => ({ ...x, id: x.id ?? nextId() }) as T & { id: string };
  const world = {
    records: (initial.records ?? []).map(withId) as FakeRecord[],
    domains: (initial.domains ?? []).map(withId) as FakeDomain[],
    hostnames: [...(initial.hostnames ?? [])],
    pages: { ...initial.pages } as Record<string, string>,
    calls: [] as string[],
    /** Fails the first call that starts like this ("POST /zones/..."). */
    failOn: null as string | null,
  };

  const handle = (method: string, path: string, body: any): unknown => {
    const [base = '', query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    let m: RegExpMatchArray | null;

    if ((m = base.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      const [, zone, id] = m;
      if (method === 'GET') return world.records.filter((r) => r.zone === zone && (!q.get('type') || r.type === q.get('type')));
      if (method === 'POST') {
        if (world.domains.some((d) => d.hostname === body.name)) throw new Error('record conflicts with Custom Domain');
        const r = { id: nextId(), zone: zone!, ...body };
        world.records.push(r);
        return r;
      }
      if (method === 'DELETE') {
        world.records = world.records.filter((r) => r.id !== id);
        return undefined;
      }
    }
    if ((m = base.match(/^\/accounts\/([^/]+)\/workers\/domains(?:\/([^/]+))?$/))) {
      const [, account, id] = m;
      if (method === 'GET') return world.domains.filter((d) => d.account === account);
      if (method === 'PUT') {
        if (world.records.some((r) => r.name === body.hostname)) throw new Error('hostname has DNS records');
        if (!world.domains.some((d) => d.hostname === body.hostname)) {
          world.domains.push({ id: nextId(), account: account!, hostname: body.hostname, service: body.service });
        }
        return {};
      }
      if (method === 'DELETE') {
        world.domains = world.domains.filter((d) => d.id !== id);
        return undefined;
      }
    }
    if ((m = base.match(/^\/accounts\/[^/]+\/pages\/projects\/[^/]+\/domains\/([^/]+)$/))) {
      const domain = m[1]!;
      if (method === 'GET') return { name: domain, status: world.pages[domain] ?? 'active' };
      if (method === 'PATCH') {
        world.pages[domain] = 'pending';
        return {};
      }
    }
    if ((m = base.match(/^\/zones\/[^/]+\/custom_hostnames(?:\/([^/]+))?$/))) {
      const id = m[1];
      if (method === 'GET') {
        const size = Number(q.get('per_page') ?? 50);
        const page = Number(q.get('page') ?? 1);
        return world.hostnames.slice((page - 1) * size, page * size);
      }
      if (method === 'POST') {
        const h = { id: nextId(), hostname: body.hostname, status: 'pending' };
        world.hostnames.push(h);
        return h;
      }
      if (method === 'PATCH') {
        const h = world.hostnames.find((x) => x.id === id)!;
        h.status = 'pending';
        return h;
      }
    }
    throw new Error(`fake: ${method} ${path} not implemented`);
  };

  const api: CfApi = async <T,>(method: string, path: string, body?: unknown) => {
    const call = `${method} ${path}`;
    world.calls.push(call);
    if (world.failOn && call.startsWith(world.failOn)) {
      world.failOn = null;
      throw new Error(`simulated failure on ${call}`);
    }
    return handle(method, path, body) as T;
  };

  return { world, api, apis: { zone: api, reserve: api } };
}

const PUBLIC = [...SHOP.hosts, ...DOCS.hosts].map((h) => h.name);

/** Both fixture sites served normally, ready for a block. */
export function normalCloudflare(over: { hostnames?: FakeHostname[]; pages?: Record<string, string> } = {}) {
  return fakeCloudflare({
    domains: ['example.com', 'www.example.com', 'origin.example.com'].map((hostname) => ({
      account: SHOP.accountId,
      hostname,
      service: 'site',
    })),
    records: [
      { zone: DOCS.zoneId, type: 'CNAME', name: 'example.org', content: 'example-docs.pages.dev', proxied: true },
      { zone: DOCS.zoneId, type: 'CNAME', name: 'app.example.org', content: TUNNEL, proxied: true },
      { zone: DOCS.zoneId, type: 'CNAME', name: 'origin-app.example.org', content: TUNNEL, proxied: true },
    ],
    hostnames: over.hostnames ?? PUBLIC.map((hostname, i) => ({ id: `h${i}`, hostname, status: 'pending' })),
    pages: over.pages,
  });
}
