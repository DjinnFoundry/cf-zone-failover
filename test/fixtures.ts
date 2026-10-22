import { resolveConfig, type GuardConfig } from '../src/config.js';

/** Documentation-only names and IPs (RFC 2606, RFC 5737). */
export const CONFIG: GuardConfig = {
  primary: {
    accountId: 'account-primary',
    zoneId: 'zone-primary',
    worker: 'site',
    publicHosts: ['example.com', 'www.example.com'],
    probeHost: 'origin.example.com',
  },
  reserve: {
    zoneId: 'zone-reserve',
    fallbackHost: 'fallback.example.net',
    healthUrl: 'https://reserve-check.example.com/',
  },
  seedIps: { zone: ['192.0.2.5', '192.0.2.6'], reserve: ['198.51.100.8', '198.51.100.9'] },
};
export const RESOLVED = resolveConfig(CONFIG);
export const ZONE_IPS = ['192.0.2.5', '192.0.2.6'];
export const RESERVE_IPS = ['198.51.100.8', '198.51.100.9'];
export const NOW = Date.parse('2026-10-25T18:00:00Z');
