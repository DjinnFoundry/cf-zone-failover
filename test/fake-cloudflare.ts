// Tests only: the part of the Cloudflare API the reserve touches, in memory.
import type { CfApi } from '../src/cloudflare.js';
import { RESOLVED } from './fixtures.js';

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string | null;
}
export interface FakeHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { validation_records?: { txt_name?: string; txt_value?: string }[] };
  ownership_verification?: { type?: string; name?: string; value?: string };
}

export function fakeCloudflare(initial: {
  records?: FakeRecord[];
  domains?: string[];
  hostnames?: FakeHostname[];
}) {
  let seq = 0;
  const nextId = () => `id${++seq}`;
  const world = {
    records: [...(initial.records ?? [])],
    domains: (initial.domains ?? []).map((hostname) => ({ id: nextId(), hostname })),
    hostnames: [...(initial.hostnames ?? [])],
    calls: [] as string[],
    /** Fails the first call that starts like this ("POST /zones/..."). */
    failOn: null as string | null,
  };

  const records = `/zones/${RESOLVED.primary.zoneId}/dns_records`;
  const domains = `/accounts/${RESOLVED.primary.accountId}/workers/domains`;
  const hostnames = `/zones/${RESOLVED.reserve.zoneId}/custom_hostnames`;

  const handle = (method: string, path: string, body: any): unknown => {
    const [base = '', query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    if (base === records && method === 'GET') return world.records.filter((r) => !q.get('type') || r.type === q.get('type'));
    if (base === records && method === 'POST') {
      if (world.domains.some((d) => d.hostname === body.name)) throw new Error('record conflicts with Custom Domain');
      const r = { id: nextId(), ...body };
      world.records.push(r);
      return r;
    }
    if (base.startsWith(`${records}/`) && method === 'DELETE') {
      world.records = world.records.filter((r) => r.id !== base.split('/').pop());
      return undefined;
    }
    if (base === domains && method === 'GET') return world.domains;
    if (base === domains && method === 'PUT') {
      if (world.records.some((r) => r.name === body.hostname)) throw new Error('hostname has DNS records');
      if (!world.domains.some((d) => d.hostname === body.hostname)) world.domains.push({ id: nextId(), hostname: body.hostname });
      return {};
    }
    if (base.startsWith(`${domains}/`) && method === 'DELETE') {
      world.domains = world.domains.filter((d) => d.id !== base.split('/').pop());
      return undefined;
    }
    if (base === hostnames && method === 'GET') return world.hostnames;
    if (base === hostnames && method === 'POST') {
      const h = { id: nextId(), hostname: body.hostname, status: 'pending' };
      world.hostnames.push(h);
      return h;
    }
    if (base.startsWith(`${hostnames}/`) && method === 'PATCH') {
      const h = world.hostnames.find((x) => x.id === base.split('/').pop())!;
      h.status = 'pending';
      return h;
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

  return { world, apis: { primary: api, reserve: api } };
}
