import type { CfApi } from './cloudflare.js';
import { targetOf, type HostConfig, type ResolvedConfig, type SiteConfig } from './config.js';
import type { Messages } from './messages.js';

/**
 * `zone` signs in the site's account and zone; `reserve` in the reserve zone.
 * They can be the same token.
 */
export interface SiteApis {
  zone: CfApi;
  reserve: CfApi;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}
interface WorkerDomain {
  id: string;
  hostname: string;
}
interface CustomHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { validation_records?: { txt_name?: string; txt_value?: string }[] };
  ownership_verification?: { type?: string; name?: string; value?: string };
}
interface PagesDomain {
  status: string;
}

const SSL_TXT = { ssl: { method: 'txt', type: 'dv' } };
const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);
/** Pages domain statuses that need no retry. */
const PAGES_SETTLED = new Set(['active', 'pending', 'initializing']);
/** Cloudflare's maximum page size for custom hostnames. */
const HOSTNAMES_PAGE = 50;

export interface Reserve {
  /** The reserve is active if a public hostname has a CNAME to the fallback host. */
  isActive(): Promise<boolean>;
  /**
   * Takes each public hostname off its zone (Worker Custom Domain or DNS
   * records) and points it at the reserve. If it fails halfway it puts every
   * name back: a name with nothing is down for everyone.
   */
  activate(): Promise<void>;
  /** Removes the reserve CNAMEs and puts each public hostname back where it was served. */
  deactivate(): Promise<void>;
  /**
   * Outside a block, keeps the site ready for the next one and returns what
   * changed:
   * - each public hostname is served from its zone (repairs a half-done return);
   * - the Worker origins, origin records and probe exist;
   * - Pages custom domains that lost validation retry it;
   * - each public hostname is a custom hostname of the reserve, reactivated
   *   from `moved` (Cloudflare deletes it after 7 days otherwise);
   * - the validation TXT records Cloudflare asks for are in the zone, and old
   *   ones with the marker are gone.
   */
  maintain(changes: Messages['change']): Promise<string[]>;
}

export function createReserve(apis: SiteApis, site: SiteConfig, config: Pick<ResolvedConfig, 'reserve' | 'dns'>): Reserve {
  const { reserve, dns } = config;
  const fallback = reserve.fallbackHost;
  const records = `/zones/${site.zoneId}/dns_records`;
  const workerDomains = `/accounts/${site.accountId}/workers/domains`;
  const customHostnames = `/zones/${reserve.zoneId}/custom_hostnames`;
  const pagesDomain = (h: Extract<HostConfig, { via: 'pages' }>) =>
    `/accounts/${site.accountId}/pages/projects/${h.project}/domains/${h.name}`;
  const names = new Set(site.hosts.map((h) => h.name));
  const hasWorkers = site.hosts.some((h) => h.via === 'worker');

  const zoneRecords = () => apis.zone<DnsRecord[]>('GET', `${records}?per_page=1000`);
  const domains = async () => (hasWorkers ? apis.zone<WorkerDomain[]>('GET', workerDomains) : []);
  const isReserveCname = (r: DnsRecord) => r.type === 'CNAME' && names.has(r.name) && r.content === fallback;
  /** Records that serve a name from the zone, not from the reserve. */
  const servingRecords = (all: DnsRecord[], name: string) =>
    all.filter((r) => r.name === name && ADDRESS_TYPES.has(r.type) && r.content !== fallback);

  const attachDomain = (hostname: string, worker: string) =>
    apis.zone('PUT', workerDomains, { hostname, service: worker, zone_id: site.zoneId, environment: 'production' });
  const createRecord = (name: string, r: { type: string; content: string }, comment?: string) =>
    apis.zone('POST', records, { type: r.type, name, content: r.content, proxied: true, ttl: 1, ...(comment ? { comment } : {}) });
  const deleteRecord = (r: DnsRecord) => apis.zone('DELETE', `${records}/${r.id}`);

  /** Puts back every public hostname that is not served from the zone; returns which. */
  async function servePrimary(all: DnsRecord[], attached: WorkerDomain[]): Promise<string[]> {
    const restored: string[] = [];
    for (const host of site.hosts) {
      if (host.via === 'worker') {
        if (attached.some((d) => d.hostname === host.name)) continue;
        await attachDomain(host.name, host.worker);
      } else {
        if (servingRecords(all, host.name).length > 0) continue;
        const from: { type: string; content: string }[] =
          host.via === 'pages' ? [{ type: 'CNAME', content: targetOf(host) }] : servingRecords(all, host.origin);
        if (from.length === 0) throw new Error(`${host.name}: no DNS record of its origin to copy`);
        for (const r of from) await createRecord(host.name, r);
      }
      restored.push(host.name);
    }
    return restored;
  }

  async function restore(): Promise<string[]> {
    const all = await zoneRecords();
    for (const r of all.filter(isReserveCname)) await deleteRecord(r);
    return servePrimary(all.filter((r) => !isReserveCname(r)), await domains());
  }

  /** Worker origins, origin records copied from their public name, and the probe. */
  async function ensureTargets(all: DnsRecord[], attached: WorkerDomain[], say: Messages['change']): Promise<string[]> {
    const changes: string[] = [];
    const attachedNames = new Set(attached.map((d) => d.hostname));
    const recordNames = new Set(all.filter((r) => ADDRESS_TYPES.has(r.type)).map((r) => r.name));
    for (const host of site.hosts) {
      if (host.via === 'worker' && !attachedNames.has(host.origin)) {
        await attachDomain(host.origin, host.worker);
        attachedNames.add(host.origin);
        changes.push(say.targetCreated(host.origin));
      }
      if (host.via === 'origin' && !recordNames.has(host.origin)) {
        const from = servingRecords(all, host.name);
        if (from.length === 0) throw new Error(`${host.origin}: no record of ${host.name} to copy`);
        for (const r of from) await createRecord(host.origin, r, `${dns.marker}: what the reserve fetches for ${host.name}`);
        recordNames.add(host.origin);
        changes.push(say.targetCreated(host.origin));
      }
    }
    if (!attachedNames.has(site.probeHost) && !recordNames.has(site.probeHost)) {
      await createRecord(site.probeHost, { type: 'AAAA', content: '100::' }, `${dns.marker}: probe of the zone's IPs`);
      changes.push(say.targetCreated(site.probeHost));
    }
    return changes;
  }

  async function revalidatePages(say: Messages['change']): Promise<string[]> {
    const changes: string[] = [];
    for (const host of site.hosts) {
      if (host.via !== 'pages') continue;
      const domain = await apis.zone<PagesDomain>('GET', pagesDomain(host));
      if (PAGES_SETTLED.has(domain.status)) continue;
      await apis.zone('PATCH', pagesDomain(host));
      changes.push(say.pagesRevalidated(host.name, domain.status));
    }
    return changes;
  }

  async function reserveHostnames(): Promise<CustomHostname[]> {
    const all: CustomHostname[] = [];
    for (let page = 1; ; page++) {
      const batch = await apis.reserve<CustomHostname[]>('GET', `${customHostnames}?per_page=${HOSTNAMES_PAGE}&page=${page}`);
      all.push(...batch);
      if (batch.length < HOSTNAMES_PAGE) return all;
    }
  }

  async function ensureCustomHostnames(all: DnsRecord[], say: Messages['change']): Promise<string[]> {
    const changes: string[] = [];
    const existing = await reserveHostnames();
    const hostnames: CustomHostname[] = [];
    for (const { name } of site.hosts) {
      let h = existing.find((x) => x.hostname === name);
      if (!h) {
        h = await apis.reserve<CustomHostname>('POST', customHostnames, { hostname: name, ...SSL_TXT });
        changes.push(say.recreated(name));
      } else if (h.status === 'moved') {
        h = await apis.reserve<CustomHostname>('PATCH', `${customHostnames}/${h.id}`, SSL_TXT);
        changes.push(say.reactivated(name));
      }
      hostnames.push(h);
    }

    const wanted = new Map<string, Set<string>>();
    const want = (name?: string, value?: string) => {
      if (!name || !value) return;
      if (!wanted.has(name)) wanted.set(name, new Set());
      wanted.get(name)!.add(value);
    };
    for (const h of hostnames) {
      for (const v of h.ssl?.validation_records ?? []) want(v.txt_name, v.txt_value);
      if (h.ownership_verification?.type === 'txt') want(h.ownership_verification.name, h.ownership_verification.value);
    }

    const unquote = (s: string) => s.replace(/^"|"$/g, '');
    for (const [name, values] of wanted) {
      const existingTxt = all.filter((r) => r.type === 'TXT' && r.name === name);
      for (const value of values) {
        if (existingTxt.some((r) => unquote(r.content) === value)) continue;
        await apis.zone('POST', records, { type: 'TXT', name, content: `"${value}"`, ttl: 300, comment: dns.txtComment });
        changes.push(say.txtAdded(name));
      }
      // Only the reserve's own records: the zone uses other, hidden TXT records for its own certificate.
      for (const r of existingTxt) {
        if (r.comment?.includes(dns.marker) && !values.has(unquote(r.content))) {
          await deleteRecord(r);
          changes.push(say.txtRemoved(name));
        }
      }
    }
    return changes;
  }

  return {
    async isActive() {
      return (await zoneRecords()).some(isReserveCname);
    },

    async activate() {
      const [all, attached] = await Promise.all([zoneRecords(), domains()]);
      try {
        for (const host of site.hosts) {
          if (host.via === 'worker') {
            for (const d of attached.filter((d) => d.hostname === host.name)) await apis.zone('DELETE', `${workerDomains}/${d.id}`);
          } else {
            for (const r of servingRecords(all, host.name)) await deleteRecord(r);
          }
          await apis.zone('POST', records, {
            type: 'CNAME',
            name: host.name,
            content: fallback,
            proxied: false,
            ttl: 60,
            comment: dns.cnameComment,
          });
        }
      } catch (error) {
        await restore();
        throw error;
      }
    },

    async deactivate() {
      await restore();
    },

    async maintain(say) {
      const [all, attached] = await Promise.all([zoneRecords(), domains()]);
      const restored = (await servePrimary(all, attached)).map(say.restored);
      // Re-read: the repair may have created what the next steps look for.
      const [fresh, freshDomains] = restored.length ? await Promise.all([zoneRecords(), domains()]) : [all, attached];
      return [
        ...restored,
        ...(await ensureTargets(fresh, freshDomains, say)),
        ...(await revalidatePages(say)),
        ...(await ensureCustomHostnames(fresh, say)),
      ];
    },
  };
}
