import { describe, expect, it } from 'vitest';
import {
  carrierSyncState,
  countsByCarrier,
  failedCarriers,
  syncErrorKey,
  type SyncRun,
} from './syncStatus';

const run = (over: Partial<SyncRun>): SyncRun => ({
  id: Math.random().toString(36),
  carrier: 'speedy',
  status: 'ok',
  stage: 'done',
  trigger: 'cron',
  source: 'speedy_public_list',
  started_at: '2026-11-10T01:00:00Z',
  finished_at: '2026-11-10T01:00:05Z',
  fetched: 1389,
  inserted: 0,
  updated: 0,
  unchanged: 1389,
  reactivated: 0,
  deactivated: 0,
  warnings: [],
  error_code: null,
  ...over,
});

describe('carrierSyncState / failedCarriers (P4-10 banner)', () => {
  it('no runs: nothing to show', () => {
    expect(carrierSyncState([], 'econt')).toEqual({
      latest: null,
      lastOk: null,
      running: false,
      failed: null,
    });
    expect(failedCarriers([])).toEqual([]);
  });

  it('the newest finished run failed → banner, and the last good sync is still known', () => {
    const ok = run({ started_at: '2026-11-03T01:00:00Z' });
    const failed = run({
      status: 'failed',
      error_code: 'parse_failed',
      started_at: '2026-11-10T01:00:00Z',
    });
    const state = carrierSyncState([ok, failed], 'speedy');
    expect(state.failed).toBe(failed);
    expect(state.lastOk).toBe(ok);
    expect(failedCarriers([ok, failed])).toEqual(['speedy']);
  });

  it('a later success clears it; a run in progress does not', () => {
    const failed = run({ status: 'failed', started_at: '2026-11-10T01:00:00Z' });
    const running = run({ status: 'running', started_at: '2026-11-11T01:00:00Z' });
    expect(failedCarriers([failed, running])).toEqual(['speedy']);
    expect(carrierSyncState([failed, running], 'speedy').running).toBe(true);
    const ok = run({ started_at: '2026-11-12T01:00:00Z' });
    expect(failedCarriers([failed, running, ok])).toEqual([]);
  });

  it('each courier separately', () => {
    const runs = [
      run({ carrier: 'econt', status: 'failed', error_code: 'fetch_failed' }),
      run({ carrier: 'speedy' }),
    ];
    expect(failedCarriers(runs)).toEqual(['econt']);
  });

  it('unknown error codes fall back to the general text', () => {
    expect(syncErrorKey('parse_failed')).toBe('parse_failed');
    expect(syncErrorKey('something_new')).toBe('error');
    expect(syncErrorKey(null)).toBe('error');
  });
});

describe('countsByCarrier (P4-26)', () => {
  it('adds up the types of the active points and counts the inactive ones apart', () => {
    expect(
      countsByCarrier([
        { carrier: 'econt', type: 'office', active: true, total: 569, with_coords: 569 },
        { carrier: 'econt', type: 'locker', active: true, total: 47, with_coords: 47 },
        { carrier: 'econt', type: 'mobile', active: true, total: 23, with_coords: 23 },
        { carrier: 'econt', type: 'office', active: false, total: 2, with_coords: 2 },
        { carrier: 'speedy', type: 'locker', active: true, total: 930, with_coords: 929 },
      ]),
    ).toEqual({
      econt: { office: 569, locker: 47, mobile: 23, active: 639, withCoords: 639, inactive: 2 },
      speedy: { office: 0, locker: 930, mobile: 0, active: 930, withCoords: 929, inactive: 0 },
    });
  });
});
