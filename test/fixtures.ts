import { resolveConfig, type FailoverConfig, type SiteConfig } from '../src/config.js';

/** Documentation-only names and IPs (RFC 2606, RFC 5737). */
export const ZONE_IPS = ['192.0.2.5', '192.0.2.6'];
export const DOCS_IPS = ['192.0.2.7'];
export const RESERVE_IPS = ['198.51.100.8', '198.51.100.9'];
export const NOW = Date.parse('2026-10-25T18:00:00Z');

/** A Worker on two names, with its origin as a second Custom Domain. */
export const SHOP: SiteConfig = {
  id: 'shop',
  accountId: 'account-shop',
  zoneId: 'zone-shop',
  hosts: [
    { name: 'example.com', via: 'worker', worker: 'site', origin: 'origin.example.com' },
    { name: 'www.example.com', via: 'worker', worker: 'site', origin: 'origin.example.com' },
  ],
  probeHost: 'origin.example.com',
  seedIps: ZONE_IPS,
  testHostPattern: /^reserve-check\.example\.com$/,
};

/** A Pages site and an app behind a tunnel, on another zone and account. */
export const DOCS: SiteConfig = {
  id: 'docs',
  accountId: 'account-docs',
  zoneId: 'zone-docs',
  hosts: [
    { name: 'example.org', via: 'pages', project: 'example-docs' },
    { name: 'app.example.org', via: 'origin', origin: 'origin-app.example.org' },
  ],
  probeHost: 'origin-app.example.org',
  seedIps: DOCS_IPS,
};

export const CONFIG: FailoverConfig = {
  reserve: {
    zoneId: 'zone-reserve',
    fallbackHost: 'fallback.example.net',
    healthUrl: 'https://reserve-check.example.com/',
    seedIps: RESERVE_IPS,
  },
  sites: [SHOP, DOCS],
};
export const RESOLVED = resolveConfig(CONFIG);
export const FALLBACK = CONFIG.reserve.fallbackHost;
export const TUNNEL = 'tunnel-id.cfargotunnel.example';
