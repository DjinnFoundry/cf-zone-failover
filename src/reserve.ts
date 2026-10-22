import type { CfApi } from './cloudflare.js';
import type { ResolvedConfig } from './config.js';
import type { Messages } from './messages.js';

/**
 * `primary` signs in the account and zone of the main Worker; `reserve` in the
 * reserve zone. They can be the same token if one account owns both.
 */
export interface ReserveApis {
  primary: CfApi;
  reserve: CfApi;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
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

const SSL_TXT = { ssl: { method: 'txt', type: 'dv' } };

export interface Reserve {
  /** The reserve is active if a public hostname has a CNAME to the fallback host. */
  isActive(): Promise<boolean>;
  /**
   * Detaches the production Custom Domains and points the public hostnames at
   * the reserve. If it fails halfway, it reattaches the Custom Domains: a name
   * with neither Custom Domain nor CNAME is down for everyone.
   */
  activate(): Promise<void>;
  /** Removes the reserve CNAMEs and reattaches the Custom Domains to the main Worker. */
  deactivate(): Promise<void>;
  /**
   * Keeps the reserve ready for the next block and returns what changed:
   * - a custom hostname in `moved` (the public name stopped pointing at the
   *   reserve) is reactivated; otherwise Cloudflare deletes it after 7 days;
   * - a missing one is recreated;
   * - the validation TXT records Cloudflare asks for (issuance or renewal) are
   *   put in the primary zone, and the old ones with the marker are removed.
   */
  maintain(changes: Messages['change']): Promise<string[]>;
}

export function createReserve(apis: ReserveApis, config: ResolvedConfig): Reserve {
  const { primary, reserve, dns } = config;
  const isPublic = (name: string) => primary.publicHosts.includes(name);
  const zoneRecords = `/zones/${primary.zoneId}/dns_records`;
  const workerDomains = `/accounts/${primary.accountId}/workers/domains`;
  const customHostnames = `/zones/${reserve.zoneId}/custom_hostnames`;

  async function reserveCnames(): Promise<DnsRecord[]> {
    const records = await apis.primary<DnsRecord[]>('GET', `${zoneRecords}?type=CNAME&per_page=100`);
    return records.filter((r) => isPublic(r.name) && r.content === reserve.fallbackHost);
  }

  async function attachCustomDomains(): Promise<void> {
    for (const hostname of primary.publicHosts) {
      await apis.primary('PUT', workerDomains, {
        hostname,
        service: primary.worker,
        zone_id: primary.zoneId,
        environment: 'production',
      });
    }
  }

  async function removeCnames(): Promise<void> {
    for (const r of await reserveCnames()) await apis.primary('DELETE', `${zoneRecords}/${r.id}`);
  }

  return {
    async isActive() {
      return (await reserveCnames()).length > 0;
    },

    async activate() {
      const domains = await apis.primary<WorkerDomain[]>('GET', workerDomains);
      try {
        for (const d of domains.filter((d) => isPublic(d.hostname))) {
          await apis.primary('DELETE', `${workerDomains}/${d.id}`);
        }
        for (const name of primary.publicHosts) {
          await apis.primary('POST', zoneRecords, {
            type: 'CNAME',
            name,
            content: reserve.fallbackHost,
            proxied: false,
            ttl: 60,
            comment: dns.cnameComment,
          });
        }
      } catch (error) {
        await removeCnames();
        await attachCustomDomains();
        throw error;
      }
    },

    async deactivate() {
      await removeCnames();
      await attachCustomDomains();
    },

    async maintain(say) {
      const changes: string[] = [];
      const all = await apis.reserve<CustomHostname[]>('GET', `${customHostnames}?per_page=50`);
      const hostnames: CustomHostname[] = [];

      for (const hostname of primary.publicHosts) {
        let h = all.find((x) => x.hostname === hostname);
        if (!h) {
          h = await apis.reserve<CustomHostname>('POST', customHostnames, { hostname, ...SSL_TXT });
          changes.push(say.recreated(hostname));
        } else if (h.status === 'moved') {
          h = await apis.reserve<CustomHostname>('PATCH', `${customHostnames}/${h.id}`, SSL_TXT);
          changes.push(say.reactivated(hostname));
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
      if (wanted.size === 0) return changes;

      const txt = await apis.primary<DnsRecord[]>('GET', `${zoneRecords}?type=TXT&per_page=100`);
      const unquote = (s: string) => s.replace(/^"|"$/g, '');
      for (const [name, values] of wanted) {
        const existing = txt.filter((r) => r.name === name);
        for (const value of values) {
          if (existing.some((r) => unquote(r.content) === value)) continue;
          await apis.primary('POST', zoneRecords, { type: 'TXT', name, content: `"${value}"`, ttl: 300, comment: dns.txtComment });
          changes.push(say.txtAdded(name));
        }
        // Only the reserve's own records: the zone uses other, hidden TXT records for its own certificate.
        for (const r of existing) {
          if (r.comment?.includes(dns.marker) && !values.has(unquote(r.content))) {
            await apis.primary('DELETE', `${zoneRecords}/${r.id}`);
            changes.push(say.txtRemoved(name));
          }
        }
      }
      return changes;
    },
  };
}
