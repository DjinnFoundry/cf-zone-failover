import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMING } from '../src/config.js';
import { decide, type Situation } from '../src/decide.js';
import { LOCALES } from '../src/messages.js';
import { NOW } from './fixtures.js';

const RELEASE = DEFAULT_TIMING.releaseAfterMs;
const reasons = LOCALES.en({
  hosts: ['example.com'],
  fallbackHost: 'fallback.example.net',
  healthUrl: 'https://reserve-check.example.com/',
  blocklistName: 'lists',
  workers: ['site'],
}).reason;
const base: Situation = {
  now: NOW,
  listsFresh: true,
  zoneBlockedBy: [],
  reserveBlockedBy: [],
  reserveActive: false,
  reserveHealthy: true,
  lastBlockedAt: null,
};
const at = (patch: Partial<Situation>) => decide({ ...base, ...patch }, { releaseAfterMs: RELEASE, reasons });

describe('decide', () => {
  it('does nothing without a block', () => {
    expect(at({}).action).toBe('stay');
  });

  it('activates as soon as one ISP blocks the zone', () => {
    expect(at({ zoneBlockedBy: ['movistar'] })).toMatchObject({ action: 'activate', reason: 'zone blocked by movistar' });
  });

  it('stays while the block goes on and the reserve is already active', () => {
    expect(at({ zoneBlockedBy: ['digi'], reserveActive: true }).action).toBe('stay');
  });

  it('does not activate a reserve that does not answer, and alerts', () => {
    expect(at({ zoneBlockedBy: ['orange'], reserveHealthy: false })).toMatchObject({ action: 'stay', alert: 'reserve-unhealthy' });
  });

  it('does not activate if the reserve is blocked too, and alerts', () => {
    expect(at({ zoneBlockedBy: ['orange'], reserveBlockedBy: ['orange'] })).toMatchObject({ action: 'stay', alert: 'both-blocked' });
  });

  it('decides nothing with stale lists, not even going back', () => {
    expect(at({ listsFresh: false, reserveActive: true, lastBlockedAt: NOW - 2 * RELEASE })).toMatchObject({
      action: 'stay',
      alert: 'stale-lists',
    });
  });

  it('waits for the zone to be free for the margin before going back', () => {
    expect(at({ reserveActive: true, lastBlockedAt: NOW - RELEASE + 60_000 }).action).toBe('stay');
    expect(at({ reserveActive: true, lastBlockedAt: NOW - RELEASE }).action).toBe('deactivate');
  });

  it('goes back at once if the zone is free and the reserve is the one blocked', () => {
    expect(at({ reserveActive: true, reserveBlockedBy: ['vodafone'], lastBlockedAt: NOW }).action).toBe('deactivate');
  });
});
