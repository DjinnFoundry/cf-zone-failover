import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { authorLeaks, findLeaks, loadDenylist } from '../scripts/public-data.mjs';

const leaks = (text: string, denylist: unknown[] = []) => findLeaks(text, 'f.ts', denylist) as string[];

describe('public-data check', () => {
  it('lets documentation data and the allowed public services through', () => {
    expect(
      leaks(
        [
          "publicHosts: ['example.com', 'www.example.com'], fallbackHost: 'fallback.reserve.example'",
          "url: 'https://hayahora.futbol/estado/blocked-x.txt', 'https://dns.google/resolve'",
          "seed: ['192.0.2.5', '198.51.100.8', '203.0.113.7'], resolvers @1.1.1.1 @8.8.8.8",
          "ALERT_TO: 'ops@example.com', from: guard@example.net, evil.test",
          'import { x } from "./config.js"; res.headers.get(); process.env.CI',
          'uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('flags real domains, emails, IPs and 32-hex ids', () => {
    // Built at run time so this file passes the check it tests.
    const dot = (...parts: string[]) => parts.join('.');
    const host = dot('fallback', 'my-reserve', 'com');
    const domain = dot('company', 'es');
    const ip = dot('104', '16', '1', '1');
    const found = leaks(
      [
        `fallbackHost: '${host}'`,
        `contact: someone@${domain}`,
        `zone: ['${ip}']`,
        `zoneId: '${'0123456789abcdef'.repeat(2)}'`,
      ].join('\n'),
    );

    expect(found).toEqual([
      `f.ts:1: host ${host}`,
      `f.ts:2: email on ${domain}`,
      `f.ts:3: IP ${ip}`,
      'f.ts:4: 32-hex id 012345…',
    ]);
  });

  it('checks a private denylist of literals and regexes, case-insensitive', () => {
    const denylist = loadDenylist('# ours\nSecretBrand\n/acct-[0-9]{4}/\n\n');

    expect(leaks('the secretbrand worker', denylist)).toEqual(['f.ts:1: private denylist entry']);
    expect(leaks('id ACCT-1234', denylist)).toEqual(['f.ts:1: private denylist entry']);
    expect(leaks('nothing here', denylist)).toEqual([]);
  });

  it('only accepts GitHub noreply commit identities, without echoing the address', () => {
    expect(authorLeaks(['1+me@users.noreply.github.com', 'me@corp.invalid', 'me@corp.invalid'])).toEqual([
      'commit identity …@corp.invalid is not a GitHub noreply address',
    ]);
  });
});
